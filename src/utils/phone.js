const INDIVIDUAL_SUFFIX = '@c.us';
const GROUP_SUFFIX = '@g.us';

function detectChatType(raw) {
  const value = String(raw || '').trim();
  if (value.endsWith(GROUP_SUFFIX) || /^\d+-\d+$/.test(value)) return 'group';
  return 'individual';
}

function normalizeRecipient(rawInput, explicitType) {
  if (rawInput === undefined || rawInput === null) {
    throw new Error('Recipient is required');
  }
  const value = String(rawInput).trim();
  if (!value) throw new Error('Recipient is required');

  const chatType = explicitType || detectChatType(value);

  if (chatType === 'group') {
    if (value.endsWith(GROUP_SUFFIX)) {
      const id = value.slice(0, -GROUP_SUFFIX.length);
      if (!/^\d+-\d+$/.test(id) && !/^\d+$/.test(id)) {
        throw new Error('Group ID must be digits, optionally with a dash (e.g. 1234567890-1234567890)');
      }
      return { jid: value, chatType: 'group', display: value };
    }
    if (!/^\d+(-\d+)?$/.test(value)) {
      throw new Error('Group ID must be digits, optionally with a dash');
    }
    return { jid: `${value}${GROUP_SUFFIX}`, chatType: 'group', display: value };
  }

  if (value.endsWith(INDIVIDUAL_SUFFIX)) {
    const digits = value.slice(0, -INDIVIDUAL_SUFFIX.length);
    if (!/^\d{6,15}$/.test(digits)) {
      throw new Error('Phone number must be 6-15 digits including country code, no spaces or dashes');
    }
    return { jid: value, chatType: 'individual', display: `+${digits}` };
  }

  const digits = value.startsWith('+') ? value.slice(1) : value;
  if (!/^\d{6,15}$/.test(digits)) {
    throw new Error('Phone number must include country code and contain only digits (6-15), no spaces or dashes');
  }
  return { jid: `${digits}${INDIVIDUAL_SUFFIX}`, chatType: 'individual', display: `+${digits}` };
}

module.exports = {
  normalizeRecipient,
  detectChatType,
  INDIVIDUAL_SUFFIX,
  GROUP_SUFFIX
};
