const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
export const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const OPERATOR_TIMEZONE = 'Europe/Moscow';

export function parseDateYmd(value) {
  const match = DATE_PATTERN.exec(value);
  if (!match) throw new Error(`Invalid date: ${value}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

export function formatDateYmd({ year, month, day }) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function zonedParts(date, timeZone) {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map(({ type, value }) => [type, value]),
  );
}

function timezoneOffsetMs(at, timeZone) {
  const parts = zonedParts(at, timeZone);
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
  );
  return asUtc - at.getTime();
}

export function localSlotToUtc(dateYmd, time, timeZone) {
  if (!TIME_PATTERN.test(time)) throw new Error(`Invalid time: ${time}`);
  const { year, month, day } = parseDateYmd(dateYmd);
  const [hour, minute] = time.split(':').map(Number);
  let utcMs = Date.UTC(year, month - 1, day, hour, minute);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const offset = timezoneOffsetMs(new Date(utcMs), timeZone);
    utcMs = Date.UTC(year, month - 1, day, hour, minute) - offset;
  }
  return new Date(utcMs);
}

export function slotKey(dateYmd, time, timeZone) {
  return `${dateYmd}@${time}[${timeZone}]`;
}

export function isoWeekStart(dateYmd, timeZone = OPERATOR_TIMEZONE) {
  const noon = localSlotToUtc(dateYmd, '12:00', timeZone);
  const weekday = new Date(`${dateYmd}T12:00:00Z`).getUTCDay() || 7;
  const start = new Date(noon);
  start.setUTCDate(start.getUTCDate() - (weekday - 1));
  const parts = zonedParts(start, timeZone);
  return formatDateYmd({
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
  });
}

export function addDaysYmd(dateYmd, days, timeZone = OPERATOR_TIMEZONE) {
  const base = localSlotToUtc(dateYmd, '12:00', timeZone);
  base.setUTCDate(base.getUTCDate() + days);
  const parts = zonedParts(base, timeZone);
  return formatDateYmd({
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
  });
}

export function scheduledTimesForDay(config, dateYmd) {
  const weekday = new Date(`${dateYmd}T12:00:00Z`).getUTCDay() || 7;
  const times = config.weekly ? config.weekly[weekday] || [] : config.times;
  return [...new Set(times)].sort();
}

export function weekDates(weekStartYmd, timeZone = OPERATOR_TIMEZONE) {
  const days = [];
  for (let index = 0; index < 7; index += 1) {
    days.push(addDaysYmd(weekStartYmd, index, timeZone));
  }
  return days;
}

export function operatorLabel(date, timeZone = OPERATOR_TIMEZONE) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}
