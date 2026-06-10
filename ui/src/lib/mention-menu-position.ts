const MENTION_MENU_MIN_WIDTH = 180;
const MENTION_MENU_DEFAULT_WIDTH = 520;
const MENTION_MENU_MAX_HEIGHT = 200;
const MENTION_PANEL_MAX_HEIGHT = 360;
const MENTION_MENU_VIEWPORT_PADDING = 12;
const MENTION_MENU_OFFSET = 4;
const MENTION_PANEL_OFFSET = 10;

export interface MentionMenuPositionOptions {
  width?: number;
  maxHeight?: number;
}

export interface MentionMenuAnchor {
  viewportTop: number;
  viewportBottom: number;
  viewportLeft: number;
}

export interface MentionMenuContainerAnchor {
  viewportTop: number;
  viewportBottom: number;
  viewportLeft: number;
  viewportRight: number;
}

function clamp(value: number, min: number, max: number) {
  if (max <= min) return min;
  return Math.min(Math.max(value, min), max);
}

export function getMentionMenuPositionForViewport(
  state: MentionMenuAnchor,
  viewportWidth: number,
  viewportHeight: number,
  options: MentionMenuPositionOptions = {},
) {
  const availableWidth = Math.max(
    MENTION_MENU_MIN_WIDTH,
    viewportWidth - MENTION_MENU_VIEWPORT_PADDING * 2,
  );
  const width = Math.min(options.width ?? MENTION_MENU_DEFAULT_WIDTH, availableWidth);
  const availableBelow = Math.max(
    0,
    viewportHeight - state.viewportBottom - MENTION_MENU_VIEWPORT_PADDING - MENTION_MENU_OFFSET,
  );
  const availableAbove = Math.max(
    0,
    state.viewportTop - MENTION_MENU_VIEWPORT_PADDING - MENTION_MENU_OFFSET,
  );
  const openUpward = availableBelow < 140 && availableAbove > availableBelow;
  const maxHeight = Math.min(
    options.maxHeight ?? MENTION_MENU_MAX_HEIGHT,
    openUpward ? availableAbove : availableBelow,
  );
  const left = clamp(
    state.viewportLeft,
    MENTION_MENU_VIEWPORT_PADDING,
    viewportWidth - MENTION_MENU_VIEWPORT_PADDING - width,
  );

  if (openUpward) {
    return {
      left,
      width,
      bottom: viewportHeight - state.viewportTop + MENTION_MENU_OFFSET,
      maxHeight,
    } as const;
  }

  return {
    left,
    width,
    top: state.viewportBottom + MENTION_MENU_OFFSET,
    maxHeight,
  } as const;
}

export function getMentionPanelPositionForViewport(
  state: MentionMenuContainerAnchor,
  viewportWidth: number,
  viewportHeight: number,
) {
  const availableWidth = Math.max(
    MENTION_MENU_MIN_WIDTH,
    viewportWidth - MENTION_MENU_VIEWPORT_PADDING * 2,
  );
  const desiredWidth = clamp(
    state.viewportRight - state.viewportLeft,
    MENTION_MENU_MIN_WIDTH,
    availableWidth,
  );
  const left = clamp(
    state.viewportLeft,
    MENTION_MENU_VIEWPORT_PADDING,
    viewportWidth - MENTION_MENU_VIEWPORT_PADDING - desiredWidth,
  );
  const availableBelow = Math.max(
    0,
    viewportHeight - state.viewportBottom - MENTION_MENU_VIEWPORT_PADDING - MENTION_PANEL_OFFSET,
  );
  const availableAbove = Math.max(
    0,
    state.viewportTop - MENTION_MENU_VIEWPORT_PADDING - MENTION_PANEL_OFFSET,
  );
  const openUpward = availableBelow < 160 && availableAbove > availableBelow;
  const maxHeight = Math.min(
    MENTION_PANEL_MAX_HEIGHT,
    openUpward ? availableAbove : availableBelow,
  );

  if (openUpward) {
    return {
      left,
      width: desiredWidth,
      bottom: viewportHeight - state.viewportTop + MENTION_PANEL_OFFSET,
      maxHeight,
    } as const;
  }

  return {
    left,
    width: desiredWidth,
    top: state.viewportBottom + MENTION_PANEL_OFFSET,
    maxHeight,
  } as const;
}
