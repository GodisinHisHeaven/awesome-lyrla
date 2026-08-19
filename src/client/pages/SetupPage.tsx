import {
  Check,
  ChevronRight,
  ExternalLink,
  ListMusic,
  LockKeyhole,
  LogOut,
  Minus,
  Music2,
  Plus,
  RadioTower,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
} from 'lucide-react';
import {
  FormEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Link } from 'react-router-dom';
import type {
  LyricsCandidate,
  LyricsCandidateMode,
  LyricsCandidateSet,
  PlayerSnapshot,
  SetupStatus,
  TelemetryConfigurationResult,
  TelemetryConfigurationStatus,
  TeslaVehicleSummary,
} from '../../shared/contracts.js';
import { api } from '../api.js';

interface PrivateSetup {
  virtualKeyUrl: string;
}

type CandidateLoadState = 'idle' | 'loading' | 'ready' | 'error';

export function needsTeslaAuthorizationRefresh(status: SetupStatus): boolean {
  return status.developerApp.configured
    && status.teslaAccount.connected
    && !status.teslaAccount.authorizationCurrent;
}

function redirectToTeslaAuthorization(): void {
  window.location.assign('/api/tesla/oauth/start');
}

interface SetupPageProps {
  startTeslaAuthorization?: () => void;
}

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return '时长未知';
  const totalSeconds = Math.round(durationMs / 1_000);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

function StepState({ done }: { done: boolean }) {
  return <span className={`step-state ${done ? 'done' : ''}`}>{done ? <Check size={15} /> : '·'}</span>;
}

function AdminLogin({ onSuccess }: { onSuccess: () => void }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    try {
      await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ pin }) });
      onSuccess();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '登录失败');
    }
  };
  return (
    <main className="setup-login">
      <Link className="text-link" to="/">← 返回播放器</Link>
      <form className="login-card" onSubmit={(event) => void submit(event)}>
        <span className="setup-icon"><LockKeyhole size={25} /></span>
        <p className="eyebrow">仅限车主</p>
        <h1>打开 Awesome Lyrla 设置</h1>
        <p>输入部署时设置的管理员 PIN。Tesla 凭据不会显示在浏览器中。</p>
        <label>
          管理员 PIN
          <input
            autoFocus
            autoComplete="current-password"
            inputMode="numeric"
            type="password"
            value={pin}
            onChange={(event) => setPin(event.target.value)}
            placeholder="••••"
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button className="primary-button" type="submit">解锁设置 <ChevronRight size={18} /></button>
      </form>
    </main>
  );
}

export function SetupPage({
  startTeslaAuthorization = redirectToTeslaAuthorization,
  }: SetupPageProps = {}) {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [privateSetup, setPrivateSetup] = useState<PrivateSetup | null>(null);
  const [vehicles, setVehicles] = useState<TeslaVehicleSummary[]>([]);
  const [playerSnapshot, setPlayerSnapshot] = useState<PlayerSnapshot | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [lrc, setLrc] = useState('');
  const [candidates, setCandidates] = useState<LyricsCandidate[]>([]);
  const [candidateLoadState, setCandidateLoadState] = useState<CandidateLoadState>('idle');
  const [candidateError, setCandidateError] = useState('');
  const [candidateBusy, setCandidateBusy] = useState<{ token: string; mode: LyricsCandidateMode } | null>(null);
  const [setupError, setSetupError] = useState('');
  const [sessionReload, setSessionReload] = useState(0);
  const candidateRequestId = useRef(0);
  const teslaAuthorizationStarted = useRef(false);

  const refresh = useCallback(async () => {
    setSetupError('');
    try {
      const [nextStatus, nextPrivate, nextPlayer] = await Promise.all([
        api<SetupStatus>('/api/setup/status'),
        api<PrivateSetup>('/api/setup/private'),
        api<PlayerSnapshot>('/api/player').catch(() => null),
      ]);
      setStatus(nextStatus);
      setPrivateSetup(nextPrivate);
      setPlayerSnapshot(nextPlayer);
    } catch (reason) {
      setSetupError(reason instanceof Error ? reason.message : '设置暂时无法读取');
      throw reason;
    }
  }, []);

  useEffect(() => {
    let active = true;
    setSetupError('');
    void (async () => {
      try {
        const session = await api<{ authenticated: boolean }>('/api/admin/session');
        if (!active) return;
        setAuthenticated(session.authenticated);
        if (session.authenticated) void refresh().catch(() => undefined);
      } catch (reason) {
        if (!active) return;
        setSetupError(reason instanceof Error ? reason.message : '登录状态暂时无法读取');
      }
    })();
    return () => {
      active = false;
    };
  }, [refresh, sessionReload]);

  useEffect(() => {
    if (
      !status
      || !needsTeslaAuthorizationRefresh(status)
      || teslaAuthorizationStarted.current
    ) return;
    teslaAuthorizationStarted.current = true;
    startTeslaAuthorization();
  }, [startTeslaAuthorization, status]);

  useEffect(() => {
    if (!authenticated || !status || !privateSetup || window.location.hash !== '#vehicle-activation') {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById('vehicle-activation');
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      target?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [authenticated, privateSetup, status]);

  const loadCandidates = useCallback(async () => {
    const requestId = ++candidateRequestId.current;
    setCandidateLoadState('loading');
    setCandidateError('');
    try {
      const result = await api<LyricsCandidateSet>('/api/lyrics/candidates');
      if (requestId !== candidateRequestId.current) return;
      setCandidates(result.candidates);
      setCandidateLoadState('ready');
    } catch (reason) {
      if (requestId !== candidateRequestId.current) return;
      setCandidates([]);
      setCandidateError(reason instanceof Error ? reason.message : '读取候选歌词失败');
      setCandidateLoadState('error');
    }
  }, []);

  const candidateTrackKey = playerSnapshot?.track
    ? [
        playerSnapshot.track.title,
        playerSnapshot.track.artist,
        playerSnapshot.track.album,
        playerSnapshot.track.durationMs,
      ].join('\u0000')
    : '';

  useLayoutEffect(() => {
    candidateRequestId.current += 1;
    setCandidates([]);
    setCandidateLoadState('idle');
    setCandidateError('');
    return () => {
      candidateRequestId.current += 1;
    };
  }, [candidateTrackKey]);

  const run = async (name: string, action: () => Promise<void>) => {
    setBusy(name);
    setNotice('');
    try {
      await action();
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : '操作失败');
    } finally {
      setBusy('');
    }
  };

  if (authenticated === null && setupError) {
    return (
      <main className="centered-state">
        <p className="eyebrow">暂时无法读取设置</p>
        <h1>连接没有完成</h1>
        <p>{setupError}</p>
        <button className="primary-button" type="button" onClick={() => setSessionReload((value) => value + 1)}>
          重新加载
        </button>
      </main>
    );
  }
  if (authenticated === null) return <main className="centered-state"><div className="loading-road"><span /></div></main>;
  if (!authenticated) {
    return <AdminLogin onSuccess={() => { setAuthenticated(true); void refresh(); }} />;
  }
  if ((!status || !privateSetup) && setupError) {
    return (
      <main className="centered-state">
        <p className="eyebrow">车主账户已登录</p>
        <h1>设置暂时无法读取</h1>
        <p>{setupError}</p>
        <button className="primary-button" type="button" onClick={() => void refresh().catch(() => undefined)}>
          重新加载
        </button>
      </main>
    );
  }
  if (!status || !privateSetup) return <main className="centered-state"><div className="loading-road"><span /></div></main>;

  const connectTesla = () => { window.location.href = '/api/tesla/oauth/start'; };
  const loadVehicles = () => run('vehicles', async () => {
    setVehicles(await api<TeslaVehicleSummary[]>('/api/tesla/vehicles'));
  });
  const selectVehicle = (vehicle: TeslaVehicleSummary) => run(`vehicle-${vehicle.vin}`, async () => {
    await api('/api/tesla/vehicle', {
      method: 'POST',
      body: JSON.stringify({ vin: vehicle.vin, displayName: vehicle.displayName }),
    });
    await refresh();
    setNotice(`${vehicle.displayName} 已选中，下一步请配对虚拟钥匙。`);
  });
  const configureTelemetry = () => run('telemetry', async () => {
    await api<TelemetryConfigurationResult>('/api/tesla/telemetry/configure', { method: 'POST' });
    let telemetryStatus: TelemetryConfigurationStatus | null = null;
    try {
      telemetryStatus = await api<TelemetryConfigurationStatus>('/api/tesla/telemetry/status');
    } catch {
      // The create request was accepted; a sleeping vehicle can delay status visibility.
    }
    await refresh();
    setNotice(
      telemetryStatus?.synced
        ? '车辆已接收配置，车载同步已启用。'
        : '遥测配置已被 Tesla 接受；车辆在线后会自动同步。',
    );
  });
  const logout = () => run('logout', async () => {
    await api('/api/admin/logout', { method: 'POST' });
    window.location.href = '/setup';
  });
  const saveLrc = () => run('lrc', async () => {
    await api('/api/lyrics/manual', { method: 'PUT', body: JSON.stringify({ lrc }) });
    setNotice('当前歌曲的手动 LRC 已保存。');
    setLrc('');
  });
  const adjustOffset = (changeMs: number) => run('offset', async () => {
    if (!playerSnapshot) return;
    const offsetMs = Math.max(-5_000, Math.min(5_000, playerSnapshot.manualOffsetMs + changeMs));
    const next = await api<PlayerSnapshot>('/api/lyrics/offset', {
      method: 'PUT',
      body: JSON.stringify({ offsetMs }),
    });
    setPlayerSnapshot(next);
    setNotice(`歌词时间已调整为 ${offsetMs > 0 ? '+' : ''}${(offsetMs / 1_000).toFixed(1)} 秒。`);
  });
  const selectCandidate = async (candidate: LyricsCandidate, mode: LyricsCandidateMode) => {
    setCandidateBusy({ token: candidate.token, mode });
    setCandidateError('');
    setNotice('');
    try {
      const next = await api<PlayerSnapshot>('/api/lyrics/candidate', {
        method: 'PUT',
        body: JSON.stringify({ token: candidate.token, mode }),
      });
      setPlayerSnapshot(next);
      setCandidates([]);
      setCandidateLoadState('idle');
      setNotice(mode === 'synced' ? '已使用你选择的同步歌词。' : '已使用你选择的静态歌词。');
    } catch (reason) {
      setCandidateError(reason instanceof Error ? reason.message : '应用候选歌词失败');
    } finally {
      setCandidateBusy(null);
    }
  };

  return (
    <main className="setup-shell">
      <header className="setup-header">
        <div>
          <Link className="text-link" to="/">← 返回播放器</Link>
          <p className="eyebrow">Owner console</p>
          <h1>把车、歌词和屏幕接起来</h1>
          <p>这是一次性设置。完成后，只需要在 Tesla 浏览器打开播放器。</p>
        </div>
        <div className="setup-header-actions">
          <div className="privacy-badge"><ShieldCheck size={20} /> 导航信息仅用于当前屏幕 · 不发送车辆命令</div>
          <button className="header-logout" type="button" disabled={busy === 'logout'} onClick={() => void logout()}>
            <LogOut size={16} /> 退出
          </button>
        </div>
      </header>

      {notice && <div className="notice-bar" role="status">{notice}</div>}

      <section className="setup-layout">
        <aside className="setup-steps">
          <p className="eyebrow">接入进度</p>
          <ol>
            <li><StepState done={status.teslaAccount.connected} /><span><strong>Tesla 账户</strong><small>官方 OAuth 授权</small></span></li>
            <li><StepState done={status.vehicle.selected} /><span><strong>Model Y</strong><small>{status.vehicle.maskedVin ?? '尚未选择车辆'}</small></span></li>
            <li><StepState done={status.telemetry.configured} /><span><strong>车载同步</strong><small>{status.telemetry.synced ? '车辆已同步' : status.telemetry.hostname ?? '等待 Fly 遥测入口'}</small></span></li>
          </ol>
          {status.demoMode && <div className="demo-flag"><Music2 size={18} /> 当前服务运行在演示模式</div>}
        </aside>

        <div className="setup-content">
          <section className="setup-card">
            <div className="card-heading">
              <span className="setup-icon"><Smartphone size={23} /></span>
              <div><p className="eyebrow">步骤 1</p><h2>授权 Tesla 账户与车辆</h2></div>
            </div>
            {!status.developerApp.configured ? (
              <p className="blocked-copy">先把现有应用的 Client ID 和 Client Secret 写入 Fly secrets，然后重新部署。</p>
            ) : !status.teslaAccount.connected ? (
              <button className="primary-button" onClick={connectTesla}>使用 Tesla 官方授权 <ExternalLink size={17} /></button>
            ) : (
              <>
                <div className="inline-success"><Check size={17} /> Tesla 账户已连接</div>
                <button className="secondary-button" disabled={busy === 'vehicles'} onClick={() => void loadVehicles()}>
                  <RefreshCw size={17} /> {busy === 'vehicles' ? '读取中…' : '读取我的车辆'}
                </button>
                {vehicles.length > 0 && (
                  <div className="vehicle-list">
                    {vehicles.map((vehicle) => (
                      <button key={vehicle.vin} onClick={() => void selectVehicle(vehicle)}>
                        <span><strong>{vehicle.displayName}</strong><small>{vehicle.vin.slice(0, 3)}••••••••••{vehicle.vin.slice(-4)}</small></span>
                        <span>{vehicle.state}<ChevronRight size={18} /></span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
            {status.vehicle.selected && (
              <>
                <p className="card-note">在 Tesla App 中完成虚拟钥匙配对后，启用车载同步。</p>
                <div className="action-row">
                  <a className="secondary-button" href={privateSetup.virtualKeyUrl} target="_blank" rel="noreferrer">
                    1. 配对虚拟钥匙 <ExternalLink size={17} />
                  </a>
                  <button className="primary-button" disabled={busy === 'telemetry'} onClick={() => void configureTelemetry()}>
                    <RadioTower size={17} /> {busy === 'telemetry' ? '发送中…' : '2. 启用车载同步'}
                  </button>
                </div>
              </>
            )}
          </section>

          <section className="setup-card activation-card" id="vehicle-activation">
            <div className="card-heading compact">
              <span className="setup-icon"><RadioTower size={23} /></span>
              <div><p className="eyebrow">车机入口</p><h2>在这块屏幕上直接进入</h2></div>
            </div>
            <p>
              在 Tesla 浏览器打开 <strong>{status.appOrigin.replace(/^https?:\/\//, '')}/setup</strong>，
              输入管理员 PIN 后点一下即可。授权会保存在这台车机一年。
            </p>
            <form action="/activate" method="post">
              <button className="vehicle-launch-button" type="submit">
                <span className="vehicle-launch-signal"><RadioTower size={24} /></span>
                <span className="vehicle-launch-copy">
                  <strong>激活此车机并打开歌词</strong>
                  <small>只需一次 · 以后直接打开播放器</small>
                </span>
                <ChevronRight className="vehicle-launch-arrow" size={25} />
              </button>
            </form>
          </section>

          {playerSnapshot?.track && (
            <section className="setup-card">
              <div className="card-heading compact">
                <span className="setup-icon"><SlidersHorizontal size={23} /></span>
                <div><p className="eyebrow">歌词校准</p><h2>调整歌词时间</h2></div>
              </div>
              <p>歌词出现得太晚就点加号，出现得太早就点减号。每次调整 0.5 秒。</p>
              <div className="setup-offset-control">
                <button
                  type="button"
                  disabled={busy === 'offset' || playerSnapshot.manualOffsetMs <= -5_000}
                  onClick={() => void adjustOffset(-500)}
                  aria-label="将歌词延后 0.5 秒"
                >
                  <Minus size={22} />
                </button>
                <output aria-live="polite">
                  {playerSnapshot.manualOffsetMs > 0 ? '+' : ''}{(playerSnapshot.manualOffsetMs / 1_000).toFixed(1)} 秒
                </output>
                <button
                  type="button"
                  disabled={busy === 'offset' || playerSnapshot.manualOffsetMs >= 5_000}
                  onClick={() => void adjustOffset(500)}
                  aria-label="将歌词提前 0.5 秒"
                >
                  <Plus size={22} />
                </button>
              </div>
            </section>
          )}

          {playerSnapshot?.track && (
            <section className="setup-card candidate-card" aria-labelledby="lyrics-candidate-title">
              <div className="card-heading compact">
                <span className="setup-icon"><ListMusic size={23} /></span>
                <div>
                  <p className="eyebrow">候选歌词</p>
                  <h2 id="lyrics-candidate-title">选择更合适的版本</h2>
                </div>
                {candidateLoadState === 'ready' && candidates.length > 0 && (
                  <span className="ready-chip">{candidates.length} 个候选</span>
                )}
              </div>
              <p>自动匹配不准确时，可以为当前歌曲固定一个 LRCLIB 版本。同步歌词会自动滚动，静态歌词只供手动阅读。</p>
              <div className="candidate-track-context" aria-label="当前歌曲">
                <span>正在播放</span>
                <strong>{playerSnapshot.track.title}</strong>
                <small>{playerSnapshot.track.artist || '未知歌手'}</small>
              </div>

              <div className="candidate-results" aria-busy={candidateLoadState === 'loading'}>
                {candidateLoadState === 'idle' && (
                  <div className="candidate-status">
                    <span><strong>需要换一个歌词版本？</strong><small>按需搜索 LRCLIB，不会拖慢设置页载入。</small></span>
                    <button className="secondary-button" type="button" onClick={() => void loadCandidates()}>
                      <RefreshCw size={17} /> 查找候选
                    </button>
                  </div>
                )}

                {candidateLoadState === 'loading' && (
                  <div className="candidate-status" role="status" aria-live="polite">
                    <RefreshCw className="candidate-spinner" size={20} />
                    <span><strong>正在查找候选歌词</strong><small>正在比较歌名、歌手和版本信息…</small></span>
                  </div>
                )}

                {candidateLoadState === 'error' && (
                  <div className="candidate-status candidate-status-error" role="alert">
                    <span><strong>候选歌词暂时无法读取</strong><small>{candidateError}</small></span>
                    <button className="secondary-button" type="button" onClick={() => void loadCandidates()}>
                      <RefreshCw size={17} /> 重新搜索
                    </button>
                  </div>
                )}

                {candidateLoadState === 'ready' && candidates.length === 0 && (
                  <div className="candidate-status" role="status">
                    <span><strong>没有找到可选版本</strong><small>你仍可以在下方粘贴自己的 LRC。</small></span>
                    <button className="secondary-button" type="button" onClick={() => void loadCandidates()}>
                      <RefreshCw size={17} /> 再搜索一次
                    </button>
                  </div>
                )}

                {candidateLoadState === 'ready' && candidateError && (
                  <div className="candidate-apply-error" role="alert">{candidateError}</div>
                )}

                {candidateLoadState === 'ready' && candidates.length > 0 && (
                  <ul className="candidate-list" aria-label="歌词候选列表">
                    {candidates.map((candidate, index) => {
                      const applying = candidateBusy?.token === candidate.token;
                      const canUsePlain = candidate.hasPlainLyrics || candidate.hasSyncedLyrics;
                      return (
                        <li className="candidate-item" key={candidate.token}>
                          <article aria-labelledby={`candidate-${index}-title`}>
                            <div className="candidate-heading">
                              <div className="candidate-title-block">
                                <span className="candidate-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                                <div>
                                  <h3 id={`candidate-${index}-title`}>{candidate.trackName}</h3>
                                  <p>{candidate.artistName || '未知歌手'}</p>
                                </div>
                              </div>
                              <span className="candidate-score" aria-label={`匹配度 ${candidate.matchScore}%`}>
                                {candidate.matchScore}%
                              </span>
                            </div>

                            <div className="candidate-meta">
                              {candidate.hasSyncedLyrics && <span className="candidate-tag synced">同步</span>}
                              {canUsePlain && <span className="candidate-tag">静态</span>}
                              {candidate.versionMismatch && <span className="candidate-tag mismatch">版本不同</span>}
                              <span>{formatDuration(candidate.durationMs)}</span>
                              {candidate.albumName && <span>{candidate.albumName}</span>}
                            </div>

                            {candidate.preview.length > 0 && (
                              <div className="candidate-preview" aria-label={`${candidate.trackName} 歌词预览`}>
                                {candidate.preview.slice(0, 3).map((line, lineIndex) => (
                                  <p key={`${candidate.token}-${lineIndex}`}>{line}</p>
                                ))}
                              </div>
                            )}

                            <div className="candidate-actions">
                              {candidate.hasSyncedLyrics && (
                                <button
                                  className="primary-button"
                                  type="button"
                                  disabled={Boolean(candidateBusy)}
                                  onClick={() => void selectCandidate(candidate, 'synced')}
                                  aria-label={`使用 ${candidate.trackName} 的同步歌词`}
                                >
                                  {applying && candidateBusy?.mode === 'synced' ? '正在应用…' : '使用同步歌词'}
                                </button>
                              )}
                              {canUsePlain && (
                                <button
                                  className="secondary-button"
                                  type="button"
                                  disabled={Boolean(candidateBusy)}
                                  onClick={() => void selectCandidate(candidate, 'plain')}
                                  aria-label={`静态使用 ${candidate.trackName} 的歌词`}
                                >
                                  {applying && candidateBusy?.mode === 'plain' ? '正在应用…' : '静态使用'}
                                </button>
                              )}
                            </div>
                          </article>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </section>
          )}

          <section className="setup-card">
            <div className="card-heading compact">
              <span className="setup-icon"><Music2 size={23} /></span>
              <div><p className="eyebrow">歌词修正</p><h2>为当前歌曲粘贴 LRC</h2></div>
            </div>
            <p>LRCLIB 找不到或时间轴不准时，手动版本会永久优先于在线结果。</p>
            <textarea
              className="lrc-editor"
              value={lrc}
              onChange={(event) => setLrc(event.target.value)}
              placeholder={'[00:12.50]第一句歌词\n[00:18.20]第二句歌词'}
            />
            <button className="secondary-button" disabled={!lrc.trim() || busy === 'lrc'} onClick={() => void saveLrc()}>
              保存当前歌曲的 LRC
            </button>
          </section>
        </div>
      </section>
    </main>
  );
}
