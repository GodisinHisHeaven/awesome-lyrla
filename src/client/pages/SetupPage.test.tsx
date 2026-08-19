// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type {
  LyricsCandidateSet,
  PlayerSnapshot,
  SetupStatus,
} from '../../shared/contracts.js';
import { api } from '../api.js';
import { needsTeslaAuthorizationRefresh, SetupPage } from './SetupPage.js';

vi.mock('../api.js', () => ({ api: vi.fn() }));

const status: SetupStatus = {
  demoMode: false,
  appOrigin: 'https://example.test',
  developerApp: {
    configured: true,
    callbackUrl: 'https://example.test/callback',
    publicKeyUrl: 'https://example.test/.well-known/appspecific/com.tesla.3p.public-key.pem',
    requiredScopes: ['openid'],
  },
  teslaAccount: { connected: true, authorizationCurrent: true },
  vehicle: { selected: true, maskedVin: '5YJ••••1234' },
  telemetry: {
    configured: true,
    synced: true,
    hostname: 'telemetry.example.test',
    mqttReady: true,
  },
};

const snapshot: PlayerSnapshot = {
  mode: 'live',
  connection: 'connected',
  track: {
    title: 'Midnight Circuit (Live)',
    artist: 'Local Drive',
    album: 'After Dark on Stage',
    durationMs: 221_000,
    source: 'Apple Music',
  },
  playbackStatus: 'playing',
  elapsedMs: 8_000,
  capturedAtMs: Date.now(),
  manualOffsetMs: 0,
  lyrics: { kind: 'missing', lines: [], provider: null },
  artworkPalette: null,
};

const candidateSet: LyricsCandidateSet = {
  candidates: [{
    token: 'candidate-token',
    trackName: 'Midnight Circuit',
    artistName: 'Local Drive',
    albumName: 'After Dark',
    durationMs: 214_000,
    hasSyncedLyrics: true,
    hasPlainLyrics: false,
    versionMismatch: true,
    matchScore: 91,
    preview: ['Streetlights draw a silver line', 'The city folds behind the glass'],
  }],
};

function authenticatedSetup(nextStatus: SetupStatus = status): void {
  vi.mocked(api)
    .mockResolvedValueOnce({ authenticated: true })
    .mockResolvedValueOnce(nextStatus)
    .mockResolvedValueOnce({ virtualKeyUrl: 'https://example.test/key' })
    .mockResolvedValueOnce(snapshot);
}

describe('SetupPage personal access', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
  });

  it('shows the administrator PIN form when the owner session is absent', async () => {
    vi.mocked(api).mockResolvedValueOnce({ authenticated: false });

    render(<MemoryRouter><SetupPage /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: '打开 Awesome Lyrla 设置' })).toBeInTheDocument();
    expect(screen.getByLabelText('管理员 PIN')).toBeInTheDocument();
    expect(vi.mocked(api)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api)).toHaveBeenCalledWith('/api/admin/session');
  });

  it('uses one-click activation instead of account or pairing flows', async () => {
    authenticatedSetup();

    render(<MemoryRouter><SetupPage /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: '在这块屏幕上直接进入' })).toBeInTheDocument();
    expect(screen.getByText('example.test/setup', { exact: false })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /激活此车机并打开歌词/ })).toBeInTheDocument();
    expect(screen.queryByText(/配对码/)).not.toBeInTheDocument();
  });
});

describe('SetupPage lyrics candidates', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
    authenticatedSetup();
  });

  it('loads candidates on demand and consumes a selected token once', async () => {
    let resolveCandidates!: (value: LyricsCandidateSet) => void;
    const candidateRequest = new Promise<LyricsCandidateSet>((resolve) => {
      resolveCandidates = resolve;
    });
    vi.mocked(api).mockImplementationOnce(() => candidateRequest);

    render(<MemoryRouter><SetupPage /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: '选择更合适的版本' })).toBeInTheDocument();
    expect(vi.mocked(api).mock.calls.some(([path]) => path === '/api/lyrics/candidates')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: '查找候选' }));
    expect(await screen.findByText('正在查找候选歌词')).toBeInTheDocument();

    await act(async () => resolveCandidates(candidateSet));
    expect(await screen.findByRole('heading', { name: 'Midnight Circuit' })).toBeInTheDocument();
    expect(screen.getByText('版本不同')).toBeInTheDocument();

    vi.mocked(api).mockResolvedValueOnce({
      ...snapshot,
      lyrics: {
        kind: 'synced',
        lines: [{ id: '0', startMs: 0, text: 'Streetlights draw a silver line' }],
        provider: 'lrclib',
      },
    });
    fireEvent.click(screen.getByRole('button', {
      name: '使用 Midnight Circuit 的同步歌词',
    }));

    await waitFor(() => expect(vi.mocked(api)).toHaveBeenLastCalledWith(
      '/api/lyrics/candidate',
      {
        method: 'PUT',
        body: JSON.stringify({ token: 'candidate-token', mode: 'synced' }),
      },
    ));
    expect(await screen.findByText('已使用你选择的同步歌词。')).toBeInTheDocument();
  });

  it('shows a recoverable empty state', async () => {
    vi.mocked(api).mockResolvedValueOnce({ candidates: [] });
    render(<MemoryRouter><SetupPage /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: '查找候选' }));

    expect(await screen.findByText('没有找到可选版本')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '再搜索一次' })).toBeInTheDocument();
  });
});

describe('SetupPage onboarding', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
  });

  it('keeps the owner console focused on Tesla authorization and telemetry', async () => {
    authenticatedSetup();
    render(<MemoryRouter><SetupPage /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: '授权 Tesla 账户与车辆' })).toBeInTheDocument();
    expect(screen.getByText('步骤 1')).toBeInTheDocument();
    expect(screen.queryByText('Developer 应用')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /更新导航权限/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /启用车载同步/ })).toBeInTheDocument();
  });

  it('automatically starts Tesla reauthorization when scopes are stale', async () => {
    const staleStatus = {
      ...status,
      teslaAccount: { connected: true, authorizationCurrent: false },
    };
    const startTeslaAuthorization = vi.fn();
    authenticatedSetup(staleStatus);

    render(
      <MemoryRouter>
        <SetupPage startTeslaAuthorization={startTeslaAuthorization} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(startTeslaAuthorization).toHaveBeenCalledTimes(1));
    expect(needsTeslaAuthorizationRefresh(staleStatus)).toBe(true);
    expect(needsTeslaAuthorizationRefresh(status)).toBe(false);
  });

  it('keeps a valid owner login when setup data fails', async () => {
    vi.mocked(api)
      .mockResolvedValueOnce({ authenticated: true })
      .mockRejectedValueOnce(new Error('数据库暂时不可用'))
      .mockResolvedValueOnce({ virtualKeyUrl: 'https://example.test/key' })
      .mockResolvedValueOnce(snapshot);

    render(<MemoryRouter><SetupPage /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: '设置暂时无法读取' })).toBeInTheDocument();
    expect(screen.getByText('数据库暂时不可用')).toBeInTheDocument();
    expect(screen.queryByText('管理员 PIN')).not.toBeInTheDocument();
  });

  it('keeps OAuth blocked when Tesla credentials are missing', async () => {
    authenticatedSetup({
      ...status,
      developerApp: { ...status.developerApp, configured: false },
      teslaAccount: { connected: false, authorizationCurrent: false },
    });

    render(<MemoryRouter><SetupPage /></MemoryRouter>);

    expect(await screen.findByText(/Client ID 和 Client Secret/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Tesla 官方授权/ })).not.toBeInTheDocument();
  });
});
