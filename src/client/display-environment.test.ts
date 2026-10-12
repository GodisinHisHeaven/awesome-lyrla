// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { playerChromeScales } from './display-environment.js';

const linux = 'Mozilla/5.0 (X11; Linux x86_64)';
const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';

describe('playerChromeScales', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    { name: 'viewport zoom', scale: 1.25, dpr: 1, width: 1920, height: 1200, ua: mac, controls: 1 },
    {
      name: 'current Tesla profile',
      scale: 1,
      dpr: 1.53,
      width: 1254,
      height: 784,
      ua: linux,
      controls: 1 / 1.53,
    },
    {
      name: 'combined viewport and DPR',
      scale: 1.25,
      dpr: 1.53,
      width: 1254,
      height: 784,
      ua: linux,
      controls: 1 / 1.53,
    },
    {
      name: 'ordinary high-DPR desktop',
      scale: 1,
      dpr: 2,
      width: 1920,
      height: 1080,
      ua: mac,
      controls: 1,
    },
    {
      name: 'wrong physical width',
      scale: 1,
      dpr: 2,
      width: 1000,
      height: 600,
      ua: linux,
      controls: 1,
    },
    {
      name: 'wrong physical height',
      scale: 1,
      dpr: 2,
      width: 960,
      height: 650,
      ua: linux,
      controls: 1,
    },
    {
      name: 'non-Linux matching geometry',
      scale: 1,
      dpr: 2,
      width: 960,
      height: 600,
      ua: mac,
      controls: 1,
    },
    {
      name: 'inclusive tolerance',
      scale: 1,
      dpr: 2,
      width: 972,
      height: 612,
      ua: linux,
      controls: 0.5,
    },
    {
      name: 'outside tolerance',
      scale: 1,
      dpr: 2,
      width: 972.5,
      height: 600,
      ua: linux,
      controls: 1,
    },
  ])('$name', ({ scale, dpr, width, height, ua, controls }) => {
    vi.stubGlobal('visualViewport', { scale });
    vi.stubGlobal('devicePixelRatio', dpr);
    vi.stubGlobal('screen', { width, height });
    vi.stubGlobal('navigator', { userAgent: ua });
    expect(playerChromeScales()).toEqual({ viewport: 1 / scale, controls });
  });

  it('uses normal viewport scale when VisualViewport is unavailable', () => {
    vi.stubGlobal('visualViewport', null);
    vi.stubGlobal('navigator', { userAgent: mac });
    expect(playerChromeScales()).toEqual({ viewport: 1, controls: 1 });
  });
});
