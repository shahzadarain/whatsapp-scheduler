(() => {
  const els = {
    statusDot: document.getElementById('status-dot'),
    statusText: document.getElementById('status-text'),
    statusTz: document.getElementById('status-tz'),
    qrSection: document.getElementById('qr-section'),
    qrImg: document.getElementById('qr-img'),
    form: document.getElementById('msg-form'),
    fRecipient: document.getElementById('f-recipient'),
    fType: document.getElementById('f-type'),
    fMessage: document.getElementById('f-message'),
    fSendAt: document.getElementById('f-sendat'),
    fRecurrence: document.getElementById('f-recurrence'),
    fSubmitLabel: document.getElementById('f-submit-label'),
    fCancel: document.getElementById('f-cancel'),
    formError: document.getElementById('form-error'),
    pendingTbody: document.getElementById('pending-tbody'),
    pendingCount: document.getElementById('pending-count'),
    historyTbody: document.getElementById('history-tbody'),
    captionHint: document.getElementById('caption-hint'),
    audioFields: document.getElementById('audio-fields'),
    audioPanel: document.getElementById('audio-panel'),
    audioFile: document.getElementById('f-audio-file'),
    dropzone: document.getElementById('dropzone'),
    recStart: document.getElementById('rec-start'),
    recStop: document.getElementById('rec-stop'),
    recCancel: document.getElementById('rec-cancel'),
    recRerecord: document.getElementById('rec-rerecord'),
    recClear: document.getElementById('rec-clear'),
    recTimer: document.getElementById('rec-timer'),
    recCanvas: document.getElementById('rec-waveform'),
    audioPreview: document.getElementById('audio-preview'),
    audioMeta: document.getElementById('audio-meta')
  };

  let editingId = null;
  let editingHasExistingMedia = false;

  // Audio sub-state
  let audioState = 'idle';
  let recordedBlob = null;
  let recordedExt = '.webm';
  let recordedMime = '';
  let mediaRecorder = null;
  let recChunks = [];
  let recStartedAt = 0;
  let recTimerInterval = null;
  let audioCtx = null;
  let analyser = null;
  let micStream = null;
  let drawHandle = null;

  // ---------- helpers ----------
  function selectedKind() {
    const checked = document.querySelector('input[name="msg-kind"]:checked');
    return checked ? checked.value : 'text';
  }

  function setKind(kind) {
    document.querySelectorAll('input[name="msg-kind"]').forEach((r) => { r.checked = r.value === kind; });
    onKindChange();
  }

  function onKindChange() {
    const kind = selectedKind();
    const isMedia = kind === 'voice' || kind === 'audio';
    els.audioFields.classList.toggle('hidden', !isMedia);
    els.captionHint.classList.toggle('hidden', kind !== 'audio');
    if (kind === 'text') els.fMessage.setAttribute('required', 'true');
    else els.fMessage.removeAttribute('required');
  }

  function fmtLocal(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleString(); } catch (_) { return iso; }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function statusBadge(status) {
    const map = {
      pending: 'bg-amber-100 text-amber-800',
      sent: 'bg-emerald-100 text-emerald-800',
      failed: 'bg-red-100 text-red-800'
    };
    const cls = map[status] || 'bg-slate-100 text-slate-700';
    return `<span class="inline-block px-2 py-0.5 text-xs rounded ${cls}">${escapeHtml(status)}</span>`;
  }

  function typeBadge(t) {
    const v = t || 'text';
    const icon = v === 'voice' ? '🎙️' : v === 'audio' ? '🎵' : '✉️';
    return `<span class="inline-flex items-center gap-1 text-xs">${icon} ${escapeHtml(v)}</span>`;
  }

  function fmtSize(bytes) {
    if (!Number.isFinite(bytes)) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function fmtDuration(secs) {
    const mm = String(Math.floor(secs / 60)).padStart(2, '0');
    const ss = String(secs % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  }

  // ---------- audio state machine ----------
  function setAudioState(state) {
    audioState = state;
    els.audioPanel.querySelectorAll('[data-state]').forEach((node) => {
      node.hidden = node.dataset.state !== state;
    });
  }

  function clearLocalAudio() {
    recordedBlob = null;
    recordedMime = '';
    recordedExt = '.webm';
    if (els.audioFile) els.audioFile.value = '';
    if (els.audioPreview.src) {
      try { URL.revokeObjectURL(els.audioPreview.src); } catch (_) {}
      els.audioPreview.removeAttribute('src');
      els.audioPreview.load();
    }
    els.audioMeta.textContent = '';
    setAudioState('idle');
  }

  function showReady({ src, meta }) {
    els.audioPreview.src = src;
    els.audioMeta.textContent = meta;
    setAudioState('ready');
  }

  function setUploadedFile(file) {
    recordedBlob = null;
    const url = URL.createObjectURL(file);
    showReady({
      src: url,
      meta: `${file.name} · ${fmtSize(file.size)} · ${file.type || 'audio'}`
    });
  }

  // ---------- recording ----------
  function pickRecorderMime() {
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return null;
    const candidates = [
      ['audio/ogg;codecs=opus', '.ogg'],
      ['audio/webm;codecs=opus', '.webm'],
      ['audio/webm', '.webm'],
      ['audio/mp4', '.m4a']
    ];
    for (const [mt, ext] of candidates) {
      if (MediaRecorder.isTypeSupported(mt)) return { mimeType: mt, ext };
    }
    return null;
  }

  function fitCanvas() {
    const c = els.recCanvas;
    const dpr = window.devicePixelRatio || 1;
    const rect = c.getBoundingClientRect();
    if (rect.width === 0) return;
    c.width = Math.floor(rect.width * dpr);
    c.height = Math.floor(rect.height * dpr);
  }

  function drawWaveform() {
    if (!analyser) return;
    const c = els.recCanvas;
    const ctx = c.getContext('2d');
    const W = c.width, H = c.height;

    const bins = 64;
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);

    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, W, H);

    const step = Math.max(1, Math.floor(data.length / bins));
    const barW = W / bins;
    const gap = barW * 0.25;
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#fb7185');
    grad.addColorStop(1, '#e11d48');
    ctx.fillStyle = grad;

    for (let i = 0; i < bins; i++) {
      let sum = 0;
      for (let k = 0; k < step; k++) sum += data[i * step + k] || 0;
      const v = (sum / step) / 255;
      const h = Math.max(2, v * H * 0.95);
      const x = i * barW + gap / 2;
      const y = (H - h) / 2;
      ctx.fillRect(x, y, barW - gap, h);
    }
    drawHandle = requestAnimationFrame(drawWaveform);
  }

  async function startRecording() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert('Microphone access not supported in this browser.');
      return;
    }
    const choice = pickRecorderMime();
    if (!choice) { alert('No supported audio MIME for MediaRecorder in this browser.'); return; }

    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      alert('Microphone permission denied: ' + err.message);
      return;
    }

    recChunks = [];
    mediaRecorder = new MediaRecorder(micStream, { mimeType: choice.mimeType });
    recordedExt = choice.ext;
    recordedMime = choice.mimeType.split(';')[0];

    mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      stopMicAndAnalyser();
      clearInterval(recTimerInterval);
      cancelAnimationFrame(drawHandle);

      if (!recChunks.length) {
        clearLocalAudio();
        return;
      }
      recordedBlob = new Blob(recChunks, { type: recordedMime });
      const url = URL.createObjectURL(recordedBlob);
      const elapsed = Math.floor((Date.now() - recStartedAt) / 1000);
      showReady({
        src: url,
        meta: `Recorded clip · ${fmtDuration(elapsed)} · ${fmtSize(recordedBlob.size)} · ${recordedMime}`
      });
    };

    setAudioState('recording');
    fitCanvas();

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(micStream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    drawHandle = requestAnimationFrame(drawWaveform);

    mediaRecorder.start();
    recStartedAt = Date.now();
    els.recTimer.textContent = '00:00';
    recTimerInterval = setInterval(() => {
      els.recTimer.textContent = fmtDuration(Math.floor((Date.now() - recStartedAt) / 1000));
    }, 250);
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  }

  function cancelRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      recChunks = [];
      mediaRecorder.stop();
    }
    clearLocalAudio();
  }

  function stopMicAndAnalyser() {
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
    if (audioCtx) { try { audioCtx.close(); } catch (_) {} audioCtx = null; }
    analyser = null;
  }

  // ---------- dropzone ----------
  function bindDropzone() {
    const dz = els.dropzone;
    if (!dz) return;
    ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation(); dz.classList.add('is-dragover');
    }));
    ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation(); dz.classList.remove('is-dragover');
    }));
    dz.addEventListener('drop', (e) => {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      if (!/^audio\//.test(f.type)) {
        alert('Please drop an audio file.');
        return;
      }
      els.audioFile.files = e.dataTransfer.files;
      setUploadedFile(f);
    });
  }

  // ---------- status / messages ----------
  function renderConnState(s) {
    const label = {
      ready: 'connected',
      qr: 'awaiting QR scan',
      disconnected: 'disconnected',
      reconnecting: 'reconnecting',
      authenticated: 'authenticated',
      auth_failure: 'auth failure',
      initializing: 'initializing',
      error: 'error'
    }[s.state] || s.state;
    els.statusText.textContent = label;
    els.statusTz.textContent = s.timezone ? `(tz: ${s.timezone})` : '';
    const color = s.state === 'ready' ? 'bg-emerald-400'
      : s.state === 'qr' ? 'bg-amber-400'
      : (s.state === 'reconnecting' || s.state === 'initializing' || s.state === 'authenticated') ? 'bg-yellow-300'
      : 'bg-red-500';
    els.statusDot.className = `inline-block w-3 h-3 rounded-full ${color}`;
  }

  async function refreshStatus() {
    try {
      const r = await fetch('/api/status');
      const s = await r.json();
      renderConnState(s);
      if (s.hasQr) {
        const qr = await fetch('/api/qr').then((res) => res.ok ? res.json() : null);
        if (qr && qr.qr) {
          els.qrImg.src = qr.qr;
          els.qrSection.classList.remove('hidden');
        }
      } else {
        els.qrSection.classList.add('hidden');
      }
    } catch (e) {
      els.statusText.textContent = 'server unreachable';
      els.statusDot.className = 'inline-block w-3 h-3 rounded-full bg-red-500';
    }
  }

  function messageCell(m) {
    const text = m.message_text ? escapeHtml(m.message_text) : '';
    const file = m.media_filename
      ? `<div class="text-xs text-slate-500 mt-0.5">📎 ${escapeHtml(m.media_filename)}</div>`
      : '';
    if (!text && !file) return '<span class="text-slate-400">—</span>';
    return `<div class="max-w-md truncate" title="${escapeHtml(m.message_text || '')}">${text || '<span class="text-slate-400">(no caption)</span>'}</div>${file}`;
  }

  function rowPending(m) {
    const recurrenceText = m.recurrence
      ? `${escapeHtml(m.recurrence)}${m.next_run ? `<div class="text-xs text-slate-500">next: ${fmtLocal(m.next_run)}</div>` : ''}`
      : '<span class="text-slate-400">one-time</span>';
    return `
      <tr data-id="${m.id}">
        <td class="px-4 py-2 font-mono text-xs">${escapeHtml(m.recipient)}</td>
        <td class="px-4 py-2">${typeBadge(m.message_type)}</td>
        <td class="px-4 py-2">${messageCell(m)}</td>
        <td class="px-4 py-2 whitespace-nowrap">${fmtLocal(m.send_at)}</td>
        <td class="px-4 py-2">${recurrenceText}</td>
        <td class="px-4 py-2">${statusBadge(m.status)}</td>
        <td class="px-4 py-2 text-right whitespace-nowrap">
          <button data-action="edit" class="text-sm text-emerald-700 hover:underline mr-3">Edit</button>
          <button data-action="delete" class="text-sm text-red-600 hover:underline">Delete</button>
        </td>
      </tr>
    `;
  }

  function rowHistory(m) {
    return `
      <tr>
        <td class="px-4 py-2 font-mono text-xs">${escapeHtml(m.recipient)}</td>
        <td class="px-4 py-2">${typeBadge(m.message_type)}</td>
        <td class="px-4 py-2">${messageCell(m)}</td>
        <td class="px-4 py-2 whitespace-nowrap">${fmtLocal(m.sent_at || m.send_at)}</td>
        <td class="px-4 py-2">${statusBadge(m.status)}</td>
        <td class="px-4 py-2 text-xs text-red-600">${escapeHtml(m.error_message || '')}</td>
      </tr>
    `;
  }

  async function refreshMessages() {
    try {
      const r = await fetch('/api/messages');
      const data = await r.json();
      const messages = data.messages || [];
      const pending = messages.filter((m) => m.status === 'pending');
      const history = messages.filter((m) => m.status !== 'pending').slice(0, 200);

      els.pendingCount.textContent = `${pending.length} pending`;
      els.pendingTbody.innerHTML = pending.length
        ? pending.map(rowPending).join('')
        : `<tr><td colspan="7" class="px-4 py-6 text-center text-slate-400">No scheduled messages.</td></tr>`;

      els.historyTbody.innerHTML = history.length
        ? history.map(rowHistory).join('')
        : `<tr><td colspan="6" class="px-4 py-6 text-center text-slate-400">Nothing sent yet.</td></tr>`;

      bindRowActions();
    } catch (e) { /* transient */ }
  }

  function bindRowActions() {
    els.pendingTbody.querySelectorAll('button[data-action]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const tr = e.target.closest('tr');
        const id = tr && tr.dataset.id;
        if (!id) return;
        if (btn.dataset.action === 'delete') {
          if (!confirm('Delete this scheduled message?')) return;
          await fetch(`/api/messages/${id}`, { method: 'DELETE' });
          await refreshMessages();
        } else if (btn.dataset.action === 'edit') {
          const r = await fetch(`/api/messages/${id}`).then((x) => x.json());
          startEdit(r.message);
        }
      });
    });
  }

  function startEdit(msg) {
    editingId = msg.id;
    els.fRecipient.value = msg.recipient;
    els.fType.value = msg.chat_type || 'individual';
    els.fMessage.value = msg.message_text || '';
    els.fSendAt.value = isoToLocalInput(msg.send_at);
    els.fRecurrence.value = msg.recurrence || '';
    setKind(msg.message_type || 'text');

    clearLocalAudio();
    editingHasExistingMedia = Boolean(msg.media_path);
    if (editingHasExistingMedia) {
      showReady({
        src: `/api/messages/${msg.id}/media`,
        meta: `${msg.media_filename || 'attached audio'} · ${msg.media_mimetype || ''} · existing — record or pick a new file to replace`
      });
    }

    els.fSubmitLabel.textContent = 'Update';
    els.fCancel.classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function cancelEdit() {
    editingId = null;
    editingHasExistingMedia = false;
    els.form.reset();
    setKind('text');
    clearLocalAudio();
    els.fSubmitLabel.textContent = 'Schedule';
    els.fCancel.classList.add('hidden');
    els.formError.classList.add('hidden');
  }

  function isoToLocalInput(iso) {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function localInputToIso(value) {
    return new Date(value).toISOString();
  }

  // ---------- wiring ----------
  els.recStart.addEventListener('click', startRecording);
  els.recStop.addEventListener('click', stopRecording);
  els.recCancel.addEventListener('click', cancelRecording);
  els.recRerecord.addEventListener('click', () => { clearLocalAudio(); startRecording(); });
  els.recClear.addEventListener('click', () => { clearLocalAudio(); editingHasExistingMedia = false; });

  els.audioFile.addEventListener('change', () => {
    const f = els.audioFile.files && els.audioFile.files[0];
    if (!f) return;
    setUploadedFile(f);
  });

  document.querySelectorAll('input[name="msg-kind"]').forEach((r) => {
    r.addEventListener('change', onKindChange);
  });

  bindDropzone();

  els.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    els.formError.classList.add('hidden');

    const kind = selectedKind();
    const fd = new FormData();
    fd.append('recipient', els.fRecipient.value.trim());
    fd.append('chat_type', els.fType.value);
    fd.append('message_type', kind);
    fd.append('message_text', els.fMessage.value);
    fd.append('send_at', localInputToIso(els.fSendAt.value));
    if (els.fRecurrence.value.trim()) fd.append('recurrence', els.fRecurrence.value.trim());

    if (kind === 'voice' || kind === 'audio') {
      if (recordedBlob) {
        fd.append('audio', recordedBlob, `recording${recordedExt}`);
      } else if (els.audioFile.files && els.audioFile.files[0]) {
        fd.append('audio', els.audioFile.files[0]);
      } else if (!editingHasExistingMedia) {
        els.formError.textContent = 'Record or upload an audio file before scheduling.';
        els.formError.classList.remove('hidden');
        window.scrollTo({ top: els.audioFields.offsetTop - 80, behavior: 'smooth' });
        return;
      }
    }

    const url = editingId ? `/api/messages/${editingId}` : '/api/messages';
    const method = editingId ? 'PUT' : 'POST';
    const res = await fetch(url, { method, body: fd });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Request failed' }));
      els.formError.textContent = err.error || 'Request failed';
      els.formError.classList.remove('hidden');
      return;
    }
    cancelEdit();
    await refreshMessages();
  });

  els.fCancel.addEventListener('click', cancelEdit);
  window.addEventListener('resize', () => { if (audioState === 'recording') fitCanvas(); });

  setAudioState('idle');
  onKindChange();
  refreshStatus();
  refreshMessages();
  setInterval(refreshStatus, 5000);
  setInterval(refreshMessages, 5000);
})();
