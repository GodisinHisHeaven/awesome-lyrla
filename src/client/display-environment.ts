const TESLA_SCREEN_WIDTH_PX = 1_920;
const TESLA_SCREEN_HEIGHT_PX = 1_200;
const TESLA_SCREEN_TOLERANCE_PX = 24;

function isTeslaCenterDisplay(): boolean {
  const dpr = window.devicePixelRatio;
  // Current Tesla Chromium exposes a DPR-scaled logical screen; match the
  // physical center display so ordinary desktop high-DPR screens stay unchanged.
  const physicalWidth = window.screen.width * dpr;
  const physicalHeight = window.screen.height * dpr;

  return (
    window.navigator.userAgent.includes('X11; Linux x86_64') &&
    Math.abs(physicalWidth - TESLA_SCREEN_WIDTH_PX) <= TESLA_SCREEN_TOLERANCE_PX &&
    Math.abs(physicalHeight - TESLA_SCREEN_HEIGHT_PX) <= TESLA_SCREEN_TOLERANCE_PX
  );
}

export function playerChromeScales(): { viewport: number; controls: number } {
  return {
    viewport: 1 / (window.visualViewport?.scale ?? 1),
    controls: isTeslaCenterDisplay() ? 1 / window.devicePixelRatio : 1,
  };
}
