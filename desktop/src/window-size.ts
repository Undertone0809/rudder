export const PREFERRED_DESKTOP_WINDOW_SIZE = { width: 1620, height: 1020 };
export const MINIMUM_DESKTOP_WINDOW_SIZE = { width: 1080, height: 720 };
export const DESKTOP_WINDOW_WORK_AREA_RATIO = 0.9;

export type DesktopWindowSize = {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
};

export function resolveInitialDesktopWindowSize(workArea: {
  width: number;
  height: number;
}): DesktopWindowSize {
  const minWidth = Math.min(MINIMUM_DESKTOP_WINDOW_SIZE.width, workArea.width);
  const minHeight = Math.min(MINIMUM_DESKTOP_WINDOW_SIZE.height, workArea.height);
  return {
    width: Math.max(
      minWidth,
      Math.min(
        PREFERRED_DESKTOP_WINDOW_SIZE.width,
        Math.floor(workArea.width * DESKTOP_WINDOW_WORK_AREA_RATIO),
      ),
    ),
    height: Math.max(
      minHeight,
      Math.min(
        PREFERRED_DESKTOP_WINDOW_SIZE.height,
        Math.floor(workArea.height * DESKTOP_WINDOW_WORK_AREA_RATIO),
      ),
    ),
    minWidth,
    minHeight,
  };
}
