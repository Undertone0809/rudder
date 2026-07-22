export const MIN_SAFE_LOCAL_APP_PROCESS_ID = 2;

/**
 * @param {unknown} value
 * @returns {value is number}
 */
export function isSafeLocalAppProcessId(value) {
  return Number.isSafeInteger(value) && value >= MIN_SAFE_LOCAL_APP_PROCESS_ID;
}
