import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { useReducer, useSpacetimeDB, useTable } from 'spacetimedb/react';
import { reducers, tables } from './module_bindings';
import type {
  ActivityEvent,
  SimState,
  Turf,
  TurfStats,
  Volunteer,
  Voter,
} from './module_bindings/types';
import './App.css';

const STATUS_NOT_CONTACTED = 'not_contacted';
const STATUS_CONTACTED = 'contacted';
const STATUS_LITERATURE = 'literature_dropped';
const STATUS_REFUSED = 'refused';
const STATUS_DONATED = 'donated';

const STATUS_OPTIONS = [
  STATUS_CONTACTED,
  STATUS_LITERATURE,
  STATUS_REFUSED,
  STATUS_DONATED,
] as const;

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN ?? '';

const STATUS_META: Record<
  string,
  { label: string; short: string; color: string; tone: string }
> = {
  [STATUS_NOT_CONTACTED]: {
    label: 'Not Contacted',
    short: 'NC',
    color: '#93c5fd',
    tone: 'neutral',
  },
  [STATUS_CONTACTED]: {
    label: 'Contacted',
    short: 'C',
    color: '#00a6a6',
    tone: 'green',
  },
  [STATUS_LITERATURE]: {
    label: 'Literature Dropped',
    short: 'L',
    color: '#2563eb',
    tone: 'blue',
  },
  [STATUS_REFUSED]: {
    label: 'Refused',
    short: 'R',
    color: '#ef4444',
    tone: 'red',
  },
  [STATUS_DONATED]: {
    label: 'Donated',
    short: 'D',
    color: '#facc15',
    tone: 'gold',
  },
};

type View = 'dashboard' | 'mobile' | 'simulator';

function App() {
  const [view, setView] = useHashView();
  const { isActive: connected, identity, connectionError } = useSpacetimeDB();
  const bootstrapAttemptedRef = useRef(false);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [subscriptionWaitMs, setSubscriptionWaitMs] = useState(0);
  const [selectedTurfId, setSelectedTurfId] = useState(1);

  const [turfs, turfsReady] = useTable(tables.turf);
  const [voters, votersReady] = useTable(
    tables.voter.where(row => row.turfId.eq(selectedTurfId))
  );
  const [volunteers, volunteersReady] = useTable(tables.volunteer);
  const [events, eventsReady] = useTable(tables.activityEvent);
  const [stats, statsReady] = useTable(tables.turfStats);
  const [simStates, simReady] = useTable(tables.simState);

  const ready =
    turfsReady &&
    votersReady &&
    volunteersReady &&
    eventsReady &&
    statsReady &&
    simReady;
  const subscriptionStalled = connected && !ready && subscriptionWaitMs >= 5000;

  useEffect(() => {
    if (!turfs.some(turf => turf.id === selectedTurfId) && turfs[0]) {
      setSelectedTurfId(turfs[0].id);
    }
  }, [selectedTurfId, turfs]);

  useEffect(() => {
    if (!connected || ready) {
      setSubscriptionWaitMs(0);
      return;
    }

    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setSubscriptionWaitMs(Date.now() - startedAt);
    }, 500);

    return () => window.clearInterval(timer);
  }, [connected, ready]);

  const resetDemoData = useReducer(reducers.resetDemoData);
  const claimTurf = useReducer(reducers.claimTurf);
  const updateVoterStatus = useReducer(reducers.updateVoterStatus);
  const updateVolunteerLocation = useReducer(reducers.updateVolunteerLocation);
  const completeTurf = useReducer(reducers.completeTurf);
  const seedSimulation = useReducer(reducers.seedSimulation);
  const stopSimulation = useReducer(reducers.stopSimulation);
  const simulateTick = useReducer(reducers.simulateTick);

  useEffect(() => {
    if (
      !connected ||
      !ready ||
      bootstrapAttemptedRef.current ||
      turfs.length > 0 ||
      voters.length > 0 ||
      stats.length > 0
    ) {
      return;
    }

    bootstrapAttemptedRef.current = true;
    setBootstrapError(null);
    void resetDemoData().catch(error => {
      bootstrapAttemptedRef.current = false;
      setBootstrapError(
        error instanceof Error
          ? error.message
          : 'Could not seed the Travis voter database'
      );
    });
  }, [connected, ready, resetDemoData, stats.length, turfs.length, voters.length]);

  const currentVolunteer = useMemo(
    () => findCurrentVolunteer(volunteers, identity?.toHexString()),
    [identity, volunteers]
  );

  useEffect(() => {
    if (
      view === 'mobile' &&
      currentVolunteer?.currentTurfId &&
      currentVolunteer.currentTurfId !== selectedTurfId
    ) {
      setSelectedTurfId(currentVolunteer.currentTurfId);
    }
  }, [currentVolunteer, selectedTurfId, view]);

  const selectedTurf = useMemo(
    () => turfs.find(turf => turf.id === selectedTurfId) ?? turfs[0],
    [selectedTurfId, turfs]
  );

  const selectedStats = useMemo(
    () => stats.find(row => row.turfId === selectedTurf?.id),
    [selectedTurf, stats]
  );
  const reportActionError = useCallback((label: string, error: unknown) => {
    setActionError(`${label} failed: ${formatError(error)}`);
  }, []);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">SpacetimeDB realtime field demo</p>
          <h1>Travis County turf live ops</h1>
        </div>
        <nav className="view-tabs" aria-label="App views">
          <button
            className={view === 'dashboard' ? 'active' : ''}
            onClick={() => setView('dashboard')}
          >
            Dash
          </button>
          <button
            className={view === 'mobile' ? 'active' : ''}
            onClick={() => setView('mobile')}
          >
            Mobile
          </button>
          <button
            className={view === 'simulator' ? 'active' : ''}
            onClick={() => setView('simulator')}
          >
            Sim
          </button>
        </nav>
        <div className="connection-pill" data-connected={connected}>
          <span />
          {connected ? 'Connected' : 'Offline'}
        </div>
      </header>

      {!connected && (
        <div className="notice">
          Waiting for SpacetimeDB at the configured host. Start or publish the
          database, then this client will subscribe and hydrate automatically.
          {connectionError ? ` Error: ${connectionError.message}` : ''}
        </div>
      )}
      {connected && bootstrapError && (
        <div className="notice notice-error">
          Demo data bootstrap failed: {bootstrapError}
        </div>
      )}
      {subscriptionStalled && (
        <div className="notice notice-error">
          SpacetimeDB is connected, but the Travis turf subscriptions have not
          hydrated. Publish the module schema to spacecanvas-5rvak, then refresh
          this client.
        </div>
      )}
      {actionError && (
        <div className="notice notice-error notice-action">
          <span>{actionError}</span>
          <button type="button" onClick={() => setActionError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {view === 'dashboard' && (
        <Dashboard
          completeTurf={completeTurf}
          currentVolunteer={currentVolunteer}
          events={events}
          onActionError={reportActionError}
          ready={ready}
          resetDemoData={resetDemoData}
          selectedStats={selectedStats}
          selectedTurf={selectedTurf}
          selectedTurfId={selectedTurfId}
          setSelectedTurfId={setSelectedTurfId}
          stats={stats}
          turfs={turfs}
          updateVolunteerLocation={updateVolunteerLocation}
          updateVoterStatus={updateVoterStatus}
          voters={voters}
          volunteers={volunteers}
        />
      )}

      {view === 'mobile' && (
        <MobileFieldApp
          claimTurf={claimTurf}
          completeTurf={completeTurf}
          connected={connected}
          currentVolunteer={currentVolunteer}
          onActionError={reportActionError}
          turfs={turfs}
          updateVolunteerLocation={updateVolunteerLocation}
          updateVoterStatus={updateVoterStatus}
          voters={voters}
        />
      )}

      {view === 'simulator' && (
        <SimulatorPanel
          connected={connected}
          events={events}
          onActionError={reportActionError}
          seedSimulation={seedSimulation}
          simState={simStates[0]}
          simulateTick={simulateTick}
          stats={stats}
          stopSimulation={stopSimulation}
          volunteers={volunteers}
        />
      )}
    </div>
  );
}

function Dashboard({
  completeTurf,
  currentVolunteer,
  events,
  onActionError,
  ready,
  resetDemoData,
  selectedStats,
  selectedTurf,
  selectedTurfId,
  setSelectedTurfId,
  stats,
  turfs,
  updateVolunteerLocation,
  updateVoterStatus,
  voters,
  volunteers,
}: {
  completeTurf: (params: { volunteerId: number }) => Promise<void>;
  currentVolunteer: Volunteer | undefined;
  events: readonly ActivityEvent[];
  onActionError: (label: string, error: unknown) => void;
  ready: boolean;
  resetDemoData: () => Promise<void>;
  selectedStats: TurfStats | undefined;
  selectedTurf: Turf | undefined;
  selectedTurfId: number;
  setSelectedTurfId: (id: number) => void;
  stats: readonly TurfStats[];
  turfs: readonly Turf[];
  updateVolunteerLocation: (params: {
    volunteerId: number;
    lat: number;
    lng: number;
    heading: number;
  }) => Promise<void>;
  updateVoterStatus: (params: {
    voterId: number;
    status: string;
    volunteerId: number;
    lat: number;
    lng: number;
    donationCents: number;
  }) => Promise<void>;
  voters: readonly Voter[];
  volunteers: readonly Volunteer[];
}) {
  const totals = useMemo(() => summarizeStats(stats), [stats]);
  const liveTelemetry = useMemo(
    () => buildLiveTelemetry(events, stats, turfs, voters, volunteers),
    [events, stats, turfs, voters, volunteers]
  );
  const recentEvents = useMemo(
    () => [...events].sort((a, b) => b.id - a.id).slice(0, 32),
    [events]
  );
  const recentVoterUpdates = useMemo(
    () =>
      voters
        .filter(voter => voter.updatedSeq > 0)
        .sort((a, b) => b.updatedSeq - a.updatedSeq)
        .slice(0, 14),
    [voters]
  );

  return (
    <main className="dashboard-grid">
      <section className="map-panel">
        <div className="section-header">
          <div>
            <p className="eyebrow">Realtime map</p>
            <h2>{selectedTurf?.name ?? 'Loading turf'}</h2>
          </div>
        <div className="map-actions">
            <button
              onClick={() => {
                void resetDemoData().catch(error =>
                  onActionError('Rebuild Travis turfs', error)
                );
              }}
            >
              Rebuild turfs
            </button>
            {currentVolunteer && (
              <button
                onClick={() =>
                  void completeTurf({ volunteerId: currentVolunteer.id }).catch(
                    error => onActionError('Complete turf', error)
                  )
                }
              >
                Complete my turf
              </button>
            )}
          </div>
        </div>

        <div className="metric-row">
          <Metric label="Registered voters" value={totals.total} />
          <Metric
            label="Knocked voters"
            value={totals.touched}
            accent="strong"
          />
          <Metric label="Active knockers" value={totals.activeVolunteers} />
          <Metric
            label="Live DB updates"
            value={stats.reduce((sum, row) => sum + row.updateCount, 0)}
          />
        </div>

        <LiveTelemetry telemetry={liveTelemetry} />

        <TravisMap
          currentVolunteer={currentVolunteer}
          onActionError={onActionError}
          selectedTurfId={selectedTurfId}
          setSelectedTurfId={setSelectedTurfId}
          turfs={turfs}
          updateVolunteerLocation={updateVolunteerLocation}
          updateVoterStatus={updateVoterStatus}
          voters={voters}
          volunteers={volunteers}
        />

        <div className="turf-strip">
          {turfs.map(turf => {
            const row = stats.find(item => item.turfId === turf.id);
            const percent =
              row && row.totalVoters > 0
                ? Math.round(
                    ((row.totalVoters - row.notContactedCount) /
                      row.totalVoters) *
                      100
                  )
                : 0;
            return (
              <button
                key={turf.id}
                className={turf.id === selectedTurfId ? 'selected' : ''}
                onClick={() => setSelectedTurfId(turf.id)}
              >
                <span>{turf.name}</span>
                <strong>{percent}%</strong>
              </button>
            );
          })}
        </div>

        {!ready && <div className="loading-line">Hydrating subscriptions...</div>}
      </section>

      <aside className="sidebar">
        <section className="side-section">
          <div className="section-header compact">
            <div>
              <p className="eyebrow">Selected Travis turf</p>
              <h2>{selectedTurf?.neighborhood ?? 'No turf'}</h2>
            </div>
          </div>
          <StatusBars stats={selectedStats} />
        </section>

        <section className="side-section">
          <div className="section-header compact">
            <div>
              <p className="eyebrow">Live household updates</p>
              <h2>Selected turf stream</h2>
            </div>
          </div>
          <div className="voter-list">
            {recentVoterUpdates.length === 0 ? (
              <p className="empty-state">No household updates yet.</p>
            ) : (
              recentVoterUpdates.map(voter => {
                const meta = statusMeta(voter.status);
                return (
                  <div className="voter-row" key={voter.id}>
                    <span
                      className="status-dot"
                      style={{ background: meta.color }}
                    />
                    <div className="voter-row-main">
                      <strong>{voter.householdName}</strong>
                      <span>
                        {voter.address} · {registeredVoterCount(voter)} voter
                        {registeredVoterCount(voter) === 1 ? '' : 's'}
                      </span>
                    </div>
                    <div className="voter-row-meta">
                      <span className={`status-badge ${meta.tone}`}>
                        {meta.label}
                      </span>
                      <em>Last contacted {relativeTime(voter.lastContactedAt)}</em>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>

        <section className="side-section live-feed-section">
          <div className="section-header compact">
            <div>
              <p className="eyebrow">Activity events</p>
              <h2>Reducer log</h2>
            </div>
          </div>
          <div className="event-feed">
            {recentEvents.map(event => (
              <div className="event-row" key={event.id}>
                <span className={`event-type ${statusMeta(event.status).tone}`}>
                  {statusMeta(event.status).short}
                </span>
                <div>
                  <strong>{event.message}</strong>
                  <span>{relativeTime(event.createdAt)}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      </aside>
    </main>
  );
}

function LiveTelemetry({
  telemetry,
}: {
  telemetry: {
    activeGpsRows: number;
    heatPercent: number;
    lastEventLabel: string;
    lastEventRelative: string;
    subscribedRows: number;
    writesLastMinute: number;
  };
}) {
  return (
    <div
      className="live-telemetry"
      data-hot={telemetry.writesLastMinute > 0}
    >
      <div className="telemetry-signal" aria-hidden="true">
        <span />
      </div>
      <div className="telemetry-main">
        <p className="eyebrow">Subscription pulse</p>
        <strong>{telemetry.lastEventLabel}</strong>
        <span>{telemetry.lastEventRelative}</span>
      </div>
      <div className="telemetry-stat">
        <span>Writes/min</span>
        <strong>{telemetry.writesLastMinute.toLocaleString()}</strong>
      </div>
      <div className="telemetry-stat">
        <span>GPS rows</span>
        <strong>{telemetry.activeGpsRows.toLocaleString()}</strong>
      </div>
      <div className="telemetry-stat">
        <span>Subscribed rows</span>
        <strong>{telemetry.subscribedRows.toLocaleString()}</strong>
      </div>
      <div className="telemetry-heat" aria-hidden="true">
        <span style={{ width: `${telemetry.heatPercent}%` }} />
      </div>
    </div>
  );
}

function TravisMap({
  currentVolunteer,
  onActionError,
  selectedTurfId,
  setSelectedTurfId,
  turfs,
  updateVolunteerLocation,
  updateVoterStatus,
  voters,
  volunteers,
}: {
  currentVolunteer: Volunteer | undefined;
  onActionError: (label: string, error: unknown) => void;
  selectedTurfId: number;
  setSelectedTurfId: (id: number) => void;
  turfs: readonly Turf[];
  updateVolunteerLocation: (params: {
    volunteerId: number;
    lat: number;
    lng: number;
    heading: number;
  }) => Promise<void>;
  updateVoterStatus: (params: {
    voterId: number;
    status: string;
    volunteerId: number;
    lat: number;
    lng: number;
    donationCents: number;
  }) => Promise<void>;
  voters: readonly Voter[];
  volunteers: readonly Volunteer[];
}) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapboxMap | null>(null);
  const [mapSize, setMapSize] = useState({ width: 1000, height: 720 });
  const [mapFrame, setMapFrame] = useState(0);
  const [mapError, setMapError] = useState<string | null>(null);
  const bounds = useMemo(() => getBounds(turfs), [turfs]);
  const selectedVoters = voters.filter(voter => voter.turfId === selectedTurfId);
  const activeVolunteers = volunteers.filter(
    volunteer => volunteer.active && volunteer.currentTurfId === selectedTurfId
  );
  const volunteerStride = Math.max(1, Math.ceil(activeVolunteers.length / 900));
  const volunteerSample = activeVolunteers.filter(
    (_volunteer, index) => index % volunteerStride === 0
  );

  useEffect(() => {
    const container = mapContainerRef.current;
    if (!container || mapRef.current) {
      return;
    }

    let cancelled = false;
    let createdMap: MapboxMap | null = null;

    if (!MAPBOX_TOKEN) {
      setMapError('Mapbox token missing; using fallback map');
      return;
    }

    void import('mapbox-gl')
      .then(({ default: mapboxModule }) => {
        if (cancelled || mapRef.current || !container.isConnected) {
          return;
        }

        let supported = false;
        try {
          supported = mapboxModule.supported({
            failIfMajorPerformanceCaveat: false,
          });
        } catch {
          supported = false;
        }
        if (!supported) {
          setMapError('Mapbox WebGL unavailable; using fallback map');
          return;
        }

        mapboxModule.accessToken = MAPBOX_TOKEN;
        let map: MapboxMap;
        try {
          map = new mapboxModule.Map({
            attributionControl: false,
            center: [-97.7431, 30.2672],
            container,
            pitch: 0,
            style: 'mapbox://styles/mapbox/streets-v12',
            zoom: 9.8,
          });
        } catch (error) {
          setMapError(
            error instanceof Error
              ? error.message
              : 'Mapbox failed to initialize; using fallback map'
          );
          return;
        }

        createdMap = map;
        mapRef.current = map;
        map.addControl(
          new mapboxModule.NavigationControl({ showCompass: false }),
          'top-left'
        );

        const rerenderOverlay = () => setMapFrame(frame => frame + 1);
        map.on('load', () => {
          setMapError(null);
          rerenderOverlay();
        });
        map.on('move', rerenderOverlay);
        map.on('zoom', rerenderOverlay);
        map.on('resize', rerenderOverlay);
        map.on('error', event => {
          const message =
            event.error instanceof Error
              ? event.error.message
              : 'Mapbox could not load map tiles';
          setMapError(message);
        });
      })
      .catch(error => {
        setMapError(
          error instanceof Error
            ? error.message
            : 'Mapbox failed to load; using fallback map'
        );
      });

    return () => {
      cancelled = true;
      createdMap?.remove();
      if (mapRef.current === createdMap) {
        mapRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const container = mapContainerRef.current;
    if (!container) {
      return;
    }

    const resizeObserver = new ResizeObserver(entries => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      const width = Math.max(320, entry.contentRect.width);
      const height = Math.max(420, entry.contentRect.height);
      setMapSize({ width, height });
      mapRef.current?.resize();
      setMapFrame(frame => frame + 1);
    });
    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
    const turf = turfs.find(row => row.id === selectedTurfId);
    if (!turf || !mapRef.current) {
      return;
    }
    mapRef.current.easeTo({
      center: [turf.centerLng, turf.centerLat],
      duration: 450,
      zoom: 13,
    });
  }, [selectedTurfId, turfs]);

  const project = (lat: number, lng: number) => {
    void mapFrame;
    const map = mapRef.current;
    if (map) {
      const point = map.project([lng, lat]);
      return [point.x, point.y];
    }
    return projectPoint(lat, lng, bounds);
  };

  const handleVoterClick = (voter: Voter) => {
    if (!currentVolunteer) {
      return;
    }
    void updateVoterStatus({
      voterId: voter.id,
      status:
        voter.status === STATUS_NOT_CONTACTED
          ? STATUS_LITERATURE
          : STATUS_CONTACTED,
      volunteerId: currentVolunteer.id,
      lat: voter.lat,
      lng: voter.lng,
      donationCents: 0,
    }).catch(error => onActionError('Map voter update', error));
  };

  const handleMapClick = (lat: number, lng: number) => {
    if (!currentVolunteer) {
      return;
    }
    void updateVolunteerLocation({
      volunteerId: currentVolunteer.id,
      lat,
      lng,
      heading: 0,
    }).catch(error => onActionError('Map GPS update', error));
  };

  return (
    <div className="map-wrap">
      <div className="mapbox-canvas" ref={mapContainerRef} />
      {mapError && <div className="map-error">Mapbox tiles unavailable</div>}
      <svg
        className="map-overlay"
        height={mapSize.height}
        role="img"
        aria-label="Travis County household turf map"
        viewBox={`0 0 ${mapSize.width} ${mapSize.height}`}
        width={mapSize.width}
      >
        <rect
          className="map-bg"
          x="0"
          y="0"
          width={mapSize.width}
          height={mapSize.height}
        />
        <g className="map-grid">
          {Array.from({ length: 9 }, (_, index) => (
            <line
              key={`h-${index}`}
              x1="0"
              x2={mapSize.width}
              y1={80 + index * 72}
              y2={80 + index * 72}
            />
          ))}
          {Array.from({ length: 10 }, (_, index) => (
            <line
              key={`v-${index}`}
              x1={70 + index * 92}
              x2={70 + index * 92}
              y1="0"
              y2={mapSize.height}
            />
          ))}
        </g>

        {turfs.map(turf => {
          const points = turf.boundary
            .map(point => project(point.lat, point.lng).join(','))
            .join(' ');
          const routePath = turf.walkRoute
            .map((point, index) => {
              const [x, y] = project(point.lat, point.lng);
              return `${index === 0 ? 'M' : 'L'} ${x} ${y}`;
            })
            .join(' ');
          const [labelX, labelY] = project(turf.centerLat, turf.centerLng);
          return (
            <g key={turf.id}>
              <polygon
                className={`turf-polygon ${
                  turf.id === selectedTurfId ? 'selected' : ''
                }`}
                points={points}
                onClick={() => setSelectedTurfId(turf.id)}
              />
              <path className="walk-route" d={routePath} />
              <text className="turf-label" x={labelX} y={labelY}>
                {turf.name}
              </text>
            </g>
          );
        })}

        {selectedVoters.map(voter => {
          const [x, y] = project(voter.lat, voter.lng);
          return (
            <circle
              key={voter.id}
              className="voter-point"
              cx={x}
              cy={y}
              fill={statusMeta(voter.status).color}
              onClick={() => handleVoterClick(voter)}
              r={voter.status === STATUS_NOT_CONTACTED ? 4 : 5.8}
            >
              <title>
                {voter.householdName} - {statusMeta(voter.status).label}
              </title>
            </circle>
          );
        })}

        {volunteerSample.map(volunteer => {
          const [x, y] = project(volunteer.lat, volunteer.lng);
          return (
            <g
              className={`volunteer-marker ${
                volunteer.isSimulated ? 'simulated' : 'human'
              }`}
              key={volunteer.id}
              transform={`translate(${x} ${y}) rotate(${
                (volunteer.heading * 180) / Math.PI
              })`}
            >
              <path d="M 0 -10 L 8 8 L 0 4 L -8 8 Z" />
              <title>{volunteer.displayName}</title>
            </g>
          );
        })}
      </svg>
      <button
        className="map-nudge"
        onClick={() => {
          const turf = turfs.find(row => row.id === selectedTurfId);
          if (turf) {
            handleMapClick(turf.centerLat, turf.centerLng);
          }
        }}
      >
        Pin me to selected turf
      </button>
    </div>
  );
}

function MobileFieldApp({
  claimTurf,
  completeTurf,
  connected,
  currentVolunteer,
  onActionError,
  turfs,
  updateVolunteerLocation,
  updateVoterStatus,
  voters,
}: {
  claimTurf: (params: {
    displayName: string;
    preferredTurfId: number;
  }) => Promise<void>;
  completeTurf: (params: { volunteerId: number }) => Promise<void>;
  connected: boolean;
  currentVolunteer: Volunteer | undefined;
  onActionError: (label: string, error: unknown) => void;
  turfs: readonly Turf[];
  updateVolunteerLocation: (params: {
    volunteerId: number;
    lat: number;
    lng: number;
    heading: number;
  }) => Promise<void>;
  updateVoterStatus: (params: {
    voterId: number;
    status: string;
    volunteerId: number;
    lat: number;
    lng: number;
    donationCents: number;
  }) => Promise<void>;
  voters: readonly Voter[];
}) {
  const [displayName, setDisplayName] = useState('Alex Volunteer');
  const [gpsEnabled, setGpsEnabled] = useState(false);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [selectedVoterId, setSelectedVoterId] = useState<number | null>(null);
  const [deviceLocation, setDeviceLocation] = useState<{
    accuracy: number;
    lat: number;
    lng: number;
    updatedAt: number;
  } | null>(null);
  const currentTurf = turfs.find(
    turf => turf.id === currentVolunteer?.currentTurfId
  );
  const liveDeviceLocation = gpsEnabled ? deviceLocation : null;
  const origin = liveDeviceLocation
    ? { lat: liveDeviceLocation.lat, lng: liveDeviceLocation.lng }
    : currentVolunteer
      ? { lat: currentVolunteer.lat, lng: currentVolunteer.lng }
      : undefined;
  const turfVoters = voters
    .filter(voter => voter.turfId === currentTurf?.id)
    .sort((a, b) => a.id - b.id);
  const remaining = turfVoters
    .filter(voter => voter.status === STATUS_NOT_CONTACTED)
    .sort((a, b) =>
      origin
        ? distanceBetween(origin.lat, origin.lng, a.lat, a.lng) -
          distanceBetween(origin.lat, origin.lng, b.lat, b.lng)
        : a.id - b.id
    );
  const nextVoter = remaining[0];
  const selectedVoter =
    remaining.find(voter => voter.id === selectedVoterId) ?? undefined;
  const activeVoter = selectedVoter ?? nextVoter;
  const turfVoterCount = sumRegisteredVoters(turfVoters);
  const remainingVoterCount = sumRegisteredVoters(remaining);
  const progress =
    turfVoterCount > 0
      ? Math.round(((turfVoterCount - remainingVoterCount) / turfVoterCount) * 100)
      : 0;
  const currentVolunteerId = currentVolunteer?.id;

  useEffect(() => {
    if (!gpsEnabled || !currentVolunteerId) {
      return;
    }
    if (!('geolocation' in navigator)) {
      setGpsError('GPS unavailable on this device');
      return;
    }

    let lastSentAt = 0;
    const watchId = navigator.geolocation.watchPosition(
      position => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        const accuracy = Math.round(position.coords.accuracy ?? 0);
        const updatedAt = Date.now();
        setDeviceLocation({ accuracy, lat, lng, updatedAt });
        setGpsError(null);

        if (updatedAt - lastSentAt < 1200) {
          return;
        }
        lastSentAt = updatedAt;
        const heading =
          typeof position.coords.heading === 'number' &&
          Number.isFinite(position.coords.heading)
            ? (position.coords.heading * Math.PI) / 180
            : 0;
        void updateVolunteerLocation({
          volunteerId: currentVolunteerId,
          lat,
          lng,
          heading,
        }).catch(error => onActionError('GPS location update', error));
      },
      error => {
        setGpsError(error.message || 'GPS permission denied');
      },
      {
        enableHighAccuracy: true,
        maximumAge: 5000,
        timeout: 10000,
      }
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [currentVolunteerId, gpsEnabled, updateVolunteerLocation]);

  useEffect(() => {
    if (
      selectedVoterId &&
      !remaining.some(voter => voter.id === selectedVoterId)
    ) {
      setSelectedVoterId(null);
    }
  }, [remaining, selectedVoterId]);

  const updateStatus = (status: string) => {
    if (!activeVoter || !currentVolunteer) {
      return;
    }
    const eventLocation = liveDeviceLocation ?? {
      lat: activeVoter.lat,
      lng: activeVoter.lng,
    };
    void updateVoterStatus({
      voterId: activeVoter.id,
      status,
      volunteerId: currentVolunteer.id,
      lat: eventLocation.lat,
      lng: eventLocation.lng,
      donationCents: status === STATUS_DONATED ? 5000 : 0,
    })
      .then(() => setSelectedVoterId(null))
      .catch(error => onActionError('Mobile voter update', error));
  };

  return (
    <main className="mobile-layout">
      <section className="phone-shell">
        <div className="phone-top">
          <span>{connected ? 'Live sync' : 'Offline'}</span>
          <strong>{progress}%</strong>
        </div>
        <div className="mobile-hero">
          <p className="eyebrow">Mobile canvass app</p>
          <h2>{currentTurf?.name ?? 'Claim a random turf'}</h2>
          <span>{currentTurf?.neighborhood ?? 'Travis County, TX'}</span>
        </div>

        {!currentVolunteer ? (
          <form
            className="claim-form"
            onSubmit={event => {
              event.preventDefault();
              void claimTurf({ displayName, preferredTurfId: 0 }).catch(error =>
                onActionError('Claim random turf', error)
              );
            }}
          >
            <label>
              Display name
              <input
                value={displayName}
                onChange={event => setDisplayName(event.target.value)}
              />
            </label>
            <button disabled={!connected} type="submit">
              Get random turf
            </button>
          </form>
        ) : (
          <>
            <div className="progress-bar" aria-label="Turf progress">
              <span style={{ width: `${progress}%` }} />
            </div>

            <div className="gps-card" data-active={gpsEnabled && !!deviceLocation}>
              <div>
                <p className="eyebrow">Location</p>
                <strong>
                  {gpsEnabled
                    ? deviceLocation
                      ? 'GPS live'
                      : 'GPS pending'
                    : 'GPS off'}
                </strong>
                {deviceLocation && (
                  <span>
                    +/- {deviceLocation.accuracy}m ·{' '}
                    {secondsAgo(deviceLocation.updatedAt)}s
                  </span>
                )}
                {gpsError && <span className="gps-error">{gpsError}</span>}
              </div>
              <button type="button" onClick={() => setGpsEnabled(value => !value)}>
                {gpsEnabled ? 'Stop GPS' : 'Share GPS'}
              </button>
            </div>

            {activeVoter ? (
              <article className="next-door">
                <p className="eyebrow">
                  {selectedVoter ? 'Selected household' : 'Next nearest door'}
                </p>
                <h3>{activeVoter.householdName}</h3>
                <span>
                  {activeVoter.address} · {registeredVoterCount(activeVoter)}{' '}
                  voter{registeredVoterCount(activeVoter) === 1 ? '' : 's'}
                </span>
                <div className="door-actions">
                  {STATUS_OPTIONS.map(status => (
                    <button
                      key={status}
                      className={`status-action ${statusMeta(status).tone}`}
                      onClick={() => updateStatus(status)}
                    >
                      {statusMeta(status).label}
                    </button>
                  ))}
                </div>
              </article>
            ) : (
              <article className="next-door">
                <p className="eyebrow">Turf complete</p>
                <h3>No uncontacted households remain</h3>
                <button
                  onClick={() =>
                    void completeTurf({ volunteerId: currentVolunteer.id }).catch(
                      error => onActionError('Finish turf', error)
                    )
                  }
                >
                  Finish turf
                </button>
              </article>
            )}

            <div className="mobile-list">
              {turfVoters.slice(0, 18).map(voter => (
                <button
                  aria-pressed={selectedVoterId === voter.id}
                  className="mobile-voter"
                  data-selected={selectedVoterId === voter.id}
                  disabled={voter.status !== STATUS_NOT_CONTACTED}
                  key={voter.id}
                  onClick={() => setSelectedVoterId(voter.id)}
                  type="button"
                >
                  <span
                    className="status-dot"
                    style={{ background: statusMeta(voter.status).color }}
                  />
                  <div>
                    <strong>{voter.address}</strong>
                    <span>
                      {statusMeta(voter.status).label} ·{' '}
                      {registeredVoterCount(voter)} voter
                      {registeredVoterCount(voter) === 1 ? '' : 's'}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}
      </section>
    </main>
  );
}

function SimulatorPanel({
  connected,
  events,
  onActionError,
  seedSimulation,
  simState,
  simulateTick,
  stats,
  stopSimulation,
  volunteers,
}: {
  connected: boolean;
  events: readonly ActivityEvent[];
  onActionError: (label: string, error: unknown) => void;
  seedSimulation: (params: { volunteerCount: number }) => Promise<void>;
  simState: SimState | undefined;
  simulateTick: (params: { batchSize: number }) => Promise<void>;
  stats: readonly TurfStats[];
  stopSimulation: () => Promise<void>;
  volunteers: readonly Volunteer[];
}) {
  const volunteerCount = 10000;
  const batchSize = 800;
  const [running, setRunning] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    if (!running || !connected) {
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    const loop = () => {
      if (cancelled) {
        return;
      }
      if (!inFlight.current) {
        inFlight.current = true;
        void simulateTick({ batchSize })
          .catch(error => {
            setRunning(false);
            onActionError('Simulation tick', error);
          })
          .finally(() => {
            inFlight.current = false;
          });
      }
      timer = window.setTimeout(loop, 420);
    };
    loop();
    return () => {
      cancelled = true;
      if (timer) {
        window.clearTimeout(timer);
      }
    };
  }, [batchSize, connected, onActionError, running, simulateTick]);

  const simulatedCount = volunteers.filter(volunteer => volunteer.isSimulated).length;
  const touched = summarizeStats(stats).touched;
  const outcomeRows = useMemo(() => buildOutcomeRowsFromStats(stats), [stats]);
  const recentEvents = [...events].sort((a, b) => b.id - a.id).slice(0, 16);

  return (
    <main className="sim-layout">
      <section className="sim-controls">
        <div className="section-header">
          <div>
            <p className="eyebrow">Stress simulator</p>
            <h2>One-button Travis County simulation</h2>
          </div>
          <div className="sim-state" data-running={running}>
            {running ? 'Running' : 'Stopped'}
          </div>
        </div>

        <div className="sim-buttons single">
          <button
            className="simulate-primary"
            disabled={!connected}
            onClick={() => {
              if (running) {
                setRunning(false);
                void stopSimulation().catch(error =>
                  onActionError('Stop simulation', error)
                );
                return;
              }
              void seedSimulation({ volunteerCount })
                .then(() => setRunning(true))
                .catch(error => onActionError('Simulate', error));
            }}
          >
            {running ? 'Stop simulation' : 'Simulate'}
          </button>
          <span>10,000 canvassers · 800 reducers per tick · live GPS and status writes</span>
        </div>

        <div className="metric-row">
          <Metric label="Simulated" value={simulatedCount} />
          <Metric label="Knocked voters" value={touched} accent="strong" />
          <Metric label="Ticks" value={simState?.ticks ?? 0} />
          <Metric label="Events" value={simState?.eventsEmitted ?? 0} />
        </div>

        <div className="outcome-panel">
          <div>
            <p className="eyebrow">Outcome distribution</p>
            <h3>Target mix vs live rows</h3>
          </div>
          <div className="outcome-grid">
            {outcomeRows.map(row => (
              <div className="outcome-row" key={row.label}>
                <div>
                  <span
                    className={`status-badge ${row.tone}`}
                    style={{ background: row.color }}
                  >
                    {row.label}
                  </span>
                  <em>{row.targetLabel}</em>
                </div>
                <strong>{row.count.toLocaleString()}</strong>
                <div className="bar-track">
                  <span
                    style={{
                      background: row.color,
                      width: `${row.percent}%`,
                    }}
                  />
                </div>
                <small>{row.percent}%</small>
              </div>
            ))}
          </div>
        </div>

        <div className="distribution">
          {stats.map(row => (
            <div key={row.turfId}>
              <span>Turf {row.turfId}</span>
              <strong>{row.activeVolunteerCount}</strong>
              <div>
                <span
                  style={{
                    width: `${Math.min(100, row.activeVolunteerCount / 14)}%`,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </section>

      <aside className="sim-feed">
        <div className="section-header compact">
          <div>
            <p className="eyebrow">Latest simulated reducer output</p>
            <h2>Live stream</h2>
          </div>
        </div>
        {recentEvents.map(event => (
          <div className="event-row" key={event.id}>
            <span className={`event-type ${statusMeta(event.status).tone}`}>
              {statusMeta(event.status).short}
            </span>
            <div>
              <strong>{event.message}</strong>
              <span>{relativeTime(event.createdAt)}</span>
            </div>
          </div>
        ))}
      </aside>
    </main>
  );
}

function StatusBars({ stats }: { stats: TurfStats | undefined }) {
  if (!stats) {
    return <p className="empty-state">Waiting for turf stats.</p>;
  }
  const rows = [
    [STATUS_NOT_CONTACTED, stats.notContactedCount],
    [STATUS_LITERATURE, stats.literatureDroppedCount],
    [STATUS_CONTACTED, stats.contactedCount],
    [STATUS_REFUSED, stats.refusedCount],
    [STATUS_DONATED, stats.donatedCount],
  ] as const;

  return (
    <div className="status-bars">
      {rows.map(([status, count]) => (
        <div key={status} className="status-bar-row">
          <div>
            <span>{statusMeta(status).label}</span>
            <strong>{count}</strong>
          </div>
          <div className="bar-track">
            <span
              style={{
                background: statusMeta(status).color,
                width: `${stats.totalVoters ? (count / stats.totalVoters) * 100 : 0}%`,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function Metric({
  accent,
  label,
  value,
}: {
  accent?: 'strong';
  label: string;
  value: number;
}) {
  return (
    <div className={`metric ${accent ?? ''}`}>
      <span>{label}</span>
      <strong>{value.toLocaleString()}</strong>
    </div>
  );
}

function useHashView(): [View, (view: View) => void] {
  const getView = () => {
    const value = window.location.hash.replace('#', '');
    return value === 'mobile' || value === 'simulator' ? value : 'dashboard';
  };
  const [view, setViewState] = useState<View>(getView);

  useEffect(() => {
    const handler = () => setViewState(getView());
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);

  const setView = (nextView: View) => {
    window.location.hash = nextView;
    setViewState(nextView);
  };
  return [view, setView];
}

function findCurrentVolunteer(
  volunteers: readonly Volunteer[],
  identityHex: string | undefined
) {
  if (!identityHex) {
    return undefined;
  }
  return volunteers.find(
    volunteer =>
      volunteer.active &&
      !volunteer.isSimulated &&
      volunteer.identity.toHexString() === identityHex
  );
}

function summarizeStats(stats: readonly TurfStats[]) {
  return stats.reduce(
    (acc, row) => {
      acc.total += row.totalVoters;
      acc.touched += row.totalVoters - row.notContactedCount;
      acc.activeVolunteers += row.activeVolunteerCount;
      return acc;
    },
    { activeVolunteers: 0, total: 0, touched: 0 }
  );
}

function sumRegisteredVoters(voters: readonly Voter[]) {
  return voters.reduce(
    (sum, voter) => sum + registeredVoterCount(voter),
    0
  );
}

function registeredVoterCount(voter: Voter) {
  return Math.max(1, voter.registeredVoterCount ?? 1);
}

function buildOutcomeRowsFromStats(stats: readonly TurfStats[]) {
  const total = stats.reduce(
    (sum, row) =>
      sum +
      row.literatureDroppedCount +
      row.contactedCount +
      row.donatedCount +
      row.refusedCount,
    0
  );
  const literature = stats.reduce(
    (sum, row) => sum + row.literatureDroppedCount,
    0
  );
  const contacted = stats.reduce((sum, row) => sum + row.contactedCount, 0);
  const donated = stats.reduce((sum, row) => sum + row.donatedCount, 0);
  const refused = stats.reduce((sum, row) => sum + row.refusedCount, 0);
  const rows = [
    {
      count: literature,
      label: 'Literature',
      status: STATUS_LITERATURE,
      targetLabel: 'Target 80%',
    },
    {
      count: contacted + donated,
      label: 'Contacted',
      status: STATUS_CONTACTED,
      targetLabel: 'Target 15%',
    },
    {
      count: refused,
      label: 'Refused',
      status: STATUS_REFUSED,
      targetLabel: 'Target 5%',
    },
    {
      count: donated,
      label: 'Donated',
      status: STATUS_DONATED,
      targetLabel: 'Contact subcase',
    },
  ];

  return rows.map(row => {
    const meta = statusMeta(row.status);
    return {
      ...row,
      color: meta.color,
      percent: total > 0 ? Math.round((row.count / total) * 100) : 0,
      tone: meta.tone,
    };
  });
}

function buildLiveTelemetry(
  events: readonly ActivityEvent[],
  stats: readonly TurfStats[],
  turfs: readonly Turf[],
  voters: readonly Voter[],
  volunteers: readonly Volunteer[]
) {
  const now = Date.now();
  const sortedEvents = [...events].sort((a, b) => b.id - a.id);
  const writesLastMinute = events.filter(event => {
    const createdAt = event.createdAt?.toDate?.().getTime();
    return typeof createdAt === 'number' && now - createdAt <= 60000;
  }).length;
  const activeGpsRows = volunteers.filter(volunteer => {
    if (!volunteer.active) {
      return false;
    }
    const updatedAt = volunteer.updatedAt?.toDate?.().getTime();
    return typeof updatedAt === 'number' && now - updatedAt <= 30000;
  }).length;
  const latest = sortedEvents[0];
  const heatPercent = Math.min(
    100,
    Math.round((Math.log10(writesLastMinute + 1) / Math.log10(5001)) * 100)
  );

  return {
    activeGpsRows,
    heatPercent,
    lastEventLabel: latest
      ? `${statusMeta(latest.status).label} reducer`
      : 'Waiting for reducer events',
    lastEventRelative: latest ? relativeTime(latest.createdAt) : 'No writes yet',
    subscribedRows:
      events.length + stats.length + turfs.length + voters.length + volunteers.length,
    writesLastMinute,
  };
}

function getBounds(turfs: readonly Turf[]) {
  const points = turfs.flatMap(turf => turf.boundary);
  const latValues = points.map(point => point.lat);
  const lngValues = points.map(point => point.lng);
  return {
    maxLat: Math.max(...latValues, 30.628),
    maxLng: Math.max(...lngValues, -97.37),
    minLat: Math.min(...latValues, 30.024),
    minLng: Math.min(...lngValues, -98.173),
  };
}

function projectPoint(
  lat: number,
  lng: number,
  bounds: { maxLat: number; maxLng: number; minLat: number; minLng: number }
) {
  const padding = 46;
  const width = 1000 - padding * 2;
  const height = 720 - padding * 2;
  const x = padding + ((lng - bounds.minLng) / (bounds.maxLng - bounds.minLng)) * width;
  const y = padding + ((bounds.maxLat - lat) / (bounds.maxLat - bounds.minLat)) * height;
  return [Number.isFinite(x) ? x : 500, Number.isFinite(y) ? y : 360];
}

function distanceBetween(latA: number, lngA: number, latB: number, lngB: number) {
  const latDistance = latB - latA;
  const lngDistance = lngB - lngA;
  return Math.sqrt(latDistance * latDistance + lngDistance * lngDistance);
}

function statusMeta(status: string) {
  return STATUS_META[status] ?? STATUS_META[STATUS_NOT_CONTACTED];
}

function secondsAgo(timestamp: number) {
  return Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
}

function relativeTime(timestamp: { toDate: () => Date } | undefined) {
  if (!timestamp) {
    return 'never';
  }
  const diffMs = Date.now() - timestamp.toDate().getTime();
  const seconds = Math.max(0, Math.floor(diffMs / 1000));
  if (seconds < 3) return 'now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function formatError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return 'Unknown reducer error';
  }
}

export default App;
