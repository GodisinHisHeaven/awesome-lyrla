import { Settings } from 'lucide-react';
import type { CSSProperties } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { LyricLine } from '../../shared/contracts.js';
import { SpatialAmbientBackdrop } from '../SpatialAmbientBackdrop.js';
import type { AmbientFieldPalette } from '../ambient-palette.js';
import type { SpatialColorField } from '../spatial-field.js';
import { AmbientBackdrop, LyricsStage } from './PlayerPage.js';

interface DemoScene {
  id: string;
  label: string;
  swatch: string;
  field: SpatialColorField;
  palette: AmbientFieldPalette;
}

const demoScenes: DemoScene[] = [
  {
    id: 'afterglow',
    label: '暖冷',
    swatch: 'linear-gradient(135deg, #906a52, #66505d 48%, #263345)',
    field: {
      id: 'afterglow',
      columns: 6,
      rows: 4,
      base: '#22202a',
      colors: [
        '#765a47', '#84644e', '#906a52', '#835e50', '#674a50', '#4f414a',
        '#6a554e', '#735a52', '#775b59', '#684f5c', '#55475b', '#424454',
        '#414553', '#485063', '#4d5268', '#4c4a63', '#4d4054', '#393b49',
        '#202938', '#263345', '#2d394b', '#343543', '#302d38', '#1d222c',
      ],
      cycleA: '97s',
      cycleB: '49s',
      cycleC: '139s',
      delayA: '-23s',
      delayB: '-17s',
      delayC: '-61s',
    },
    palette: {
      primary: '144 106 82',
      secondary: '72 80 99',
      bridge: '104 77 88',
      primaryAlpha: '0.48',
      secondaryAlpha: '0.38',
      bridgeAlpha: '0.2',
      cycleA: '34s',
      cycleB: '47s',
      delayA: '-11s',
      delayB: '-23s',
      key: 'ambient-demo-afterglow',
    },
  },
  {
    id: 'glacier',
    label: '青蓝',
    swatch: 'linear-gradient(135deg, #83c2d1, #65a0b3 52%, #234b5b)',
    field: {
      id: 'glacier',
      columns: 6,
      rows: 4,
      base: '#315f70',
      colors: [
        '#83c2d1', '#7cbacb', '#75b3c6', '#6fafc1', '#6dabbd', '#689faf',
        '#75b5c7', '#70aec0', '#6aa6b9', '#65a0b3', '#6099ad', '#5b91a5',
        '#5d99ad', '#5892a6', '#528a9e', '#4b8296', '#477b8e', '#417386',
        '#356779', '#315f70', '#2b5869', '#275263', '#234b5b', '#1f4653',
      ],
      cycleA: '101s',
      cycleB: '53s',
      cycleC: '149s',
      delayA: '-37s',
      delayB: '-29s',
      delayC: '-83s',
    },
    palette: {
      primary: '117 181 199',
      secondary: '49 95 112',
      bridge: '81 138 155',
      primaryAlpha: '0.43',
      secondaryAlpha: '0.35',
      bridgeAlpha: '0.19',
      cycleA: '33s',
      cycleB: '48s',
      delayA: '-17s',
      delayB: '-29s',
      key: 'ambient-demo-glacier',
    },
  },
  {
    id: 'pulse',
    label: '高对比',
    swatch: 'linear-gradient(135deg, #a06361, #67465e 48%, #244a66)',
    field: {
      id: 'pulse',
      columns: 6,
      rows: 4,
      base: '#211f36',
      colors: [
        '#714353', '#86505b', '#a06361', '#a66d61', '#87555b', '#614451',
        '#51405a', '#67465e', '#7a4d65', '#7d5267', '#68495d', '#4e4052',
        '#244a66', '#315872', '#455b78', '#5a536e', '#694f62', '#5c4653',
        '#163246', '#1d3a4e', '#2a3f52', '#3d414f', '#483e49', '#3d343c',
      ],
      cycleA: '93s',
      cycleB: '47s',
      cycleC: '137s',
      delayA: '-31s',
      delayB: '-13s',
      delayC: '-67s',
    },
    palette: {
      primary: '166 99 97',
      secondary: '49 88 114',
      bridge: '93 75 105',
      primaryAlpha: '0.46',
      secondaryAlpha: '0.37',
      bridgeAlpha: '0.21',
      cycleA: '35s',
      cycleB: '49s',
      delayA: '-21s',
      delayB: '-33s',
      key: 'ambient-demo-pulse',
    },
  },
];

const demoLines: LyricLine[] = [
  { id: 'demo-0', startMs: 0, text: '夜色沿着道路慢慢展开' },
  { id: 'demo-1', startMs: 7_500, text: '玻璃把远处的光折进此刻' },
  { id: 'demo-2', startMs: 15_000, text: 'The city bends into the glow' },
  { id: 'demo-3', startMs: 23_000, text: '霓虹与 the glow 同步呼吸。' },
  { id: 'demo-4', startMs: 31_000, text: '每一种颜色都在缓慢流动' },
  { id: 'demo-5', startMs: 39_000, text: '下一段旋律正在靠近' },
];

export function LiquidGlassDemoPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const liquidGlass = searchParams.get('style') !== 'current';
  const spatialBackground = searchParams.get('background') !== 'current';
  const selectedField = searchParams.get('field');
  const scene = demoScenes.find((candidate) => candidate.id === selectedField) ?? demoScenes[0];
  const showControls = searchParams.get('chrome') !== '0';

  const updatePreview = (key: 'background' | 'field', value: string) => {
    const next = new URLSearchParams(searchParams);
    if (key === 'background' && value === 'spatial') next.delete('background');
    else if (key === 'field' && value === demoScenes[0].id) next.delete('field');
    else next.set(key, value);
    setSearchParams(next, { replace: true });
  };

  return (
    <main
      className={[
        'am-player',
        'lg-demo',
        'ambient-demo',
        liquidGlass ? 'lg-demo--glass' : 'lg-demo--current',
        spatialBackground ? 'ambient-demo--spatial' : 'ambient-demo--current',
      ].join(' ')}
      data-background-mode={spatialBackground ? 'spatial' : 'current'}
      data-field-id={scene.id}
      data-preview-motion={liquidGlass ? 'true' : undefined}
      style={{
        '--lg-palette-primary': scene.palette.primary,
        '--lg-palette-secondary': scene.palette.secondary,
        '--lg-palette-bridge': scene.palette.bridge,
      } as CSSProperties}
    >
      {spatialBackground
        ? <SpatialAmbientBackdrop field={scene.field} />
        : <AmbientBackdrop colors={scene.palette} />}

      <header className="am-toolbar">
        <div className="am-connection" role="status">
          <span className="connection-dot is-online" />
          <span>背景实验</span>
        </div>
        <Link
          className="am-round-button"
          to="/setup"
          aria-label="打开歌词设置"
        >
          <Settings size={21} />
        </Link>
      </header>

      <section className="am-lyrics-shell">
        <section className="am-lyrics-panel" aria-label="Liquid Glass 歌词演示">
          <div className="am-lyrics-view">
            <LyricsStage
              lines={demoLines}
              elapsedMs={11_800}
              offsetMs={0}
              playbackStatus="paused"
              durationMs={47_000}
            />
          </div>
        </section>
      </section>

      {showControls && (
        <aside className="ambient-demo-controls" aria-label="背景演示控制">
          <div className="ambient-demo-mode" role="group" aria-label="背景样式">
            <button
              aria-pressed={spatialBackground}
              onClick={() => updatePreview('background', 'spatial')}
              type="button"
            >
              空间色场
            </button>
            <button
              aria-pressed={!spatialBackground}
              onClick={() => updatePreview('background', 'current')}
              type="button"
            >
              当前背景
            </button>
          </div>
          <div className="ambient-demo-scenes" role="group" aria-label="专辑色场">
            {demoScenes.map((candidate) => (
              <button
                aria-label={`切换到${candidate.label}色场`}
                aria-pressed={candidate.id === scene.id}
                key={candidate.id}
                onClick={() => updatePreview('field', candidate.id)}
                style={{ '--ambient-demo-swatch': candidate.swatch } as CSSProperties}
                type="button"
              >
                <span aria-hidden="true" />
                {candidate.label}
              </button>
            ))}
          </div>
        </aside>
      )}
    </main>
  );
}
