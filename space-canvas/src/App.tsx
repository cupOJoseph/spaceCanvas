import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { Timestamp } from 'spacetimedb';
import { useReducer, useSpacetimeDB, useTable } from 'spacetimedb/react';
import { reducers, tables } from './module_bindings';
import type {
  ActivityEvent,
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
const ANDROID_APK_DOWNLOAD_PATH = '/downloads/space-canvas-fieldops-debug.apk';

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

type TimeValue = Timestamp;

type MapVolunteer = Pick<
  Volunteer,
  | 'active'
  | 'completedCount'
  | 'currentTurfId'
  | 'displayName'
  | 'heading'
  | 'id'
  | 'isSimulated'
  | 'lat'
  | 'lng'
  | 'targetVoterId'
> & {
  updatedAt?: TimeValue;
};

type LocalVoterPatch = {
  attemptCount: number;
  donationCents: number;
  lastContactedAt: TimeValue;
  lastContactedBy: number;
  status: string;
  updatedSeq: number;
};

type LocalSimulationSnapshot = {
  active: boolean;
  completed: boolean;
  events: ActivityEvent[];
  startedAt: number | null;
  stats: TurfStats[];
  ticks: number;
  totalVolunteerMs: number;
  voterPatches: Record<number, LocalVoterPatch>;
  volunteers: MapVolunteer[];
};

type RuntimeVolunteer = MapVolunteer & {
  fromLat: number;
  fromLng: number;
  nextKnockAt: number;
  targetAddress: string;
  targetDurationMs: number;
  targetHouseholdName: string;
  targetRegisteredVoterCount: number;
  toLat: number;
  toLng: number;
  travelStartedAt: number;
};

type LocalSimulationRuntime = {
  eventSeq: number;
  events: ActivityEvent[];
  tickTimer: number;
  ticks: number;
  baseActiveVolunteerCounts: Map<number, number>;
  statsByTurf: Map<number, TurfStats>;
  totalCompletedVolunteerMs: number;
  turfQueues: Map<number, Voter[]>;
  voterPatches: Record<number, LocalVoterPatch>;
  voterSeq: number;
  volunteers: RuntimeVolunteer[];
};

const LOCAL_SIM_VOLUNTEER_COUNT = 5000;
const LOCAL_SIM_TICK_MS = 250;
const LOCAL_SIM_FLUSH_MS = 450;
const LOCAL_SIM_MIN_KNOCK_MS = 5000;
const LOCAL_SIM_MAX_KNOCK_MS = 120000;
const LOCAL_SIM_FEED_LIMIT = 48;
const LOCAL_SIM_RENDERED_VOLUNTEER_LIMIT = 5000;
const FIRST_NAMES = [
  'Joe',
  'Marie',
  'Alex',
  'Nina',
  'Sam',
  'Taylor',
  'Jordan',
  'Riley',
  'Casey',
  'Morgan',
  'Avery',
  'Drew',
  'Maya',
  'Owen',
  'Priya',
  'Luis',
];
const LAST_NAMES = [
  'Schmoe',
  'Sue',
  'Rivera',
  'Patel',
  'Johnson',
  'Garcia',
  'Nguyen',
  'Brown',
  'Martinez',
  'Lee',
  'Walker',
  'Young',
  'King',
  'Flores',
  'Hall',
  'Allen',
];

function App() {
  const [view, setView] = useHashView();
  const { isActive: connected, identity, connectionError } = useSpacetimeDB();
  const bootstrapAttemptedRef = useRef(false);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [subscriptionWaitMs, setSubscriptionWaitMs] = useState(0);
  const [selectedTurfId, setSelectedTurfId] = useState(2);

  const [turfs, turfsReady] = useTable(tables.turf);
  const [voters, votersReady] = useTable(tables.voter);
  const [volunteers, volunteersReady] = useTable(tables.volunteer);
  const [events, eventsReady] = useTable(tables.activityEvent);
  const [stats, statsReady] = useTable(tables.turfStats);
  const [, simReady] = useTable(tables.simState);

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

  const reportActionError = useCallback((label: string, error: unknown) => {
    setActionError(`${label} failed: ${formatError(error)}`);
  }, []);

  const resetDemoData = useReducer(reducers.resetDemoData);
  const claimTurf = useReducer(reducers.claimTurf);
  const updateVoterStatus = useReducer(reducers.updateVoterStatus);
  const updateVolunteerLocation = useReducer(reducers.updateVolunteerLocation);
  const completeTurf = useReducer(reducers.completeTurf);
  const localSimulation = useLocalSimulation(turfs, voters, stats, reportActionError);

  const displayedVoters = voters;
  const displayedVolunteers = useMemo(
    () =>
      localSimulation.snapshot.events.length > 0
        ? [
            ...volunteers.filter(volunteer => !volunteer.isSimulated),
            ...localSimulation.snapshot.volunteers,
          ]
        : volunteers,
    [localSimulation.snapshot.events.length, localSimulation.snapshot.volunteers, volunteers]
  );
  const displayedStats = useMemo(
    () =>
      localSimulation.snapshot.events.length > 0
        ? localSimulation.snapshot.stats
        : stats,
    [
      localSimulation.snapshot.events.length,
      localSimulation.snapshot.stats,
      stats,
    ]
  );
  const displayedEvents = useMemo(
    () =>
      localSimulation.snapshot.events.length > 0
        ? localSimulation.snapshot.events
        : events,
    [events, localSimulation.snapshot.events]
  );

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
    () => displayedStats.find(row => row.turfId === selectedTurf?.id),
    [displayedStats, selectedTurf]
  );

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
          events={displayedEvents}
          onActionError={reportActionError}
          ready={ready}
          resetDemoData={resetDemoData}
          selectedStats={selectedStats}
          selectedTurf={selectedTurf}
          selectedTurfId={selectedTurfId}
          setSelectedTurfId={setSelectedTurfId}
          stats={displayedStats}
          turfs={turfs}
          updateVolunteerLocation={updateVolunteerLocation}
          updateVoterStatus={updateVoterStatus}
          voterPatches={localSimulation.snapshot.voterPatches}
          voters={displayedVoters}
          volunteers={displayedVolunteers}
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
          events={displayedEvents}
          localSimulation={localSimulation.snapshot}
          onActionError={reportActionError}
          selectedTurfId={selectedTurfId}
          setSelectedTurfId={setSelectedTurfId}
          startLocalSimulation={localSimulation.start}
          stats={displayedStats}
          stopLocalSimulation={localSimulation.stop}
          turfs={turfs}
          updateVolunteerLocation={updateVolunteerLocation}
          updateVoterStatus={updateVoterStatus}
          voterPatches={localSimulation.snapshot.voterPatches}
          voters={displayedVoters}
          volunteers={displayedVolunteers}
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
  voterPatches,
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
  voterPatches: Record<number, LocalVoterPatch>;
  voters: readonly Voter[];
  volunteers: readonly MapVolunteer[];
}) {
  const totals = useMemo(() => summarizeStats(stats), [stats]);
  const statsByTurf = useMemo(
    () => new Map(stats.map(row => [row.turfId, row])),
    [stats]
  );
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
        .filter(voter => voter.turfId === selectedTurfId)
        .filter(voter => voter.updatedSeq > 0)
        .sort((a, b) => b.updatedSeq - a.updatedSeq)
        .slice(0, 14),
    [selectedTurfId, voters]
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
          voterPatches={voterPatches}
          voters={voters}
          volunteers={volunteers}
        />

        <div className="turf-strip">
          {turfs.map(turf => {
            const row = statsByTurf.get(turf.id);
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
  voterPatches = {},
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
  voterPatches?: Record<number, LocalVoterPatch>;
  voters: readonly Voter[];
  volunteers: readonly MapVolunteer[];
}) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapboxMap | null>(null);
  const [mapSize, setMapSize] = useState({ width: 1000, height: 720 });
  const [mapFrame, setMapFrame] = useState(0);
  const [mapError, setMapError] = useState<string | null>(null);
  const selectedTurf = useMemo(
    () => turfs.find(turf => turf.id === selectedTurfId),
    [selectedTurfId, turfs]
  );
  const mapTurfs = useMemo(
    () => (selectedTurf ? [selectedTurf] : []),
    [selectedTurf]
  );
  const bounds = useMemo(
    () => getBounds(mapTurfs.length > 0 ? mapTurfs : turfs),
    [mapTurfs, turfs]
  );
  const votersByTurf = useMemo(() => groupVotersByTurf(voters), [voters]);
  const selectedVoters = useMemo(
    () => applyLocalVoterPatches(votersByTurf.get(selectedTurfId) ?? [], voterPatches),
    [selectedTurfId, voterPatches, votersByTurf]
  );
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

        {mapTurfs.map(turf => {
          const points = turf.boundary
            .map(point => project(point.lat, point.lng).join(','))
            .join(' ');
          const [labelX, labelY] = project(turf.centerLat, turf.centerLng);
          return (
            <g key={turf.id}>
              <polygon
                className="turf-polygon selected"
                points={points}
                onClick={() => setSelectedTurfId(turf.id)}
              />
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
              fill={mapVoterColor(voter)}
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
      {currentVolunteer && (
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
      )}
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
      <a
        className="apk-download apk-download-standalone"
        download
        href={ANDROID_APK_DOWNLOAD_PATH}
      >
        download android app
      </a>
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
  localSimulation,
  onActionError,
  selectedTurfId,
  setSelectedTurfId,
  startLocalSimulation,
  stats,
  stopLocalSimulation,
  turfs,
  updateVolunteerLocation,
  updateVoterStatus,
  voterPatches,
  voters,
  volunteers,
}: {
  connected: boolean;
  events: readonly ActivityEvent[];
  localSimulation: LocalSimulationSnapshot;
  onActionError: (label: string, error: unknown) => void;
  selectedTurfId: number;
  setSelectedTurfId: (id: number) => void;
  startLocalSimulation: () => void;
  stats: readonly TurfStats[];
  stopLocalSimulation: () => void;
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
  voterPatches: Record<number, LocalVoterPatch>;
  voters: readonly Voter[];
  volunteers: readonly MapVolunteer[];
}) {
  const simulatedCount = volunteers.filter(volunteer => volunteer.isSimulated).length;
  const touched = summarizeStats(stats).touched;
  const outcomeRows = useMemo(() => buildOutcomeRowsFromStats(stats), [stats]);
  const turfProgressRows = useMemo(() => buildTurfProgressRows(stats), [stats]);
  const recentEvents = [...events]
    .sort((a, b) => b.id - a.id)
    .slice(0, LOCAL_SIM_FEED_LIMIT);
  const totalVoters = voters.length;
  const canSimulate = turfs.length > 0 && totalVoters > 0;

  return (
    <main className="sim-layout">
      <section className="sim-controls">
        <div className="section-header">
          <div>
            <p className="eyebrow">Stress simulator</p>
            <h2>One-button Travis County simulation</h2>
          </div>
          <div className="sim-state" data-running={localSimulation.active}>
            {localSimulation.active
              ? 'Running'
              : localSimulation.completed
                ? 'Complete'
                : 'Stopped'}
          </div>
        </div>

        <div className="sim-buttons single">
          <button
            className="simulate-primary"
            disabled={!canSimulate}
            onClick={() => {
              if (localSimulation.active) {
                stopLocalSimulation();
                return;
              }
              try {
                startLocalSimulation();
              } catch (error) {
                onActionError('Simulate', error);
              }
            }}
          >
            {localSimulation.active ? 'Stop simulation' : 'Simulate'}
          </button>
          <span>
            {LOCAL_SIM_VOLUNTEER_COUNT.toLocaleString()} local volunteers · 5s
            to 2m per knock · 85/10/4/1 outcome mix
            {!connected ? ' · waiting on local subscribed data' : ''}
          </span>
        </div>

        <div className="metric-row">
          <Metric label="Simulated" value={simulatedCount} />
          <Metric label="Knocked voters" value={touched} accent="strong" />
          <Metric
            label="Volunteer time"
            value={formatVolunteerTime(localSimulation.totalVolunteerMs)}
          />
          <Metric label="Events" value={recentEvents.length} />
        </div>

        <section className="sim-map-panel">
          <div className="section-header compact">
            <div>
              <p className="eyebrow">Volunteer GPS</p>
              <h3>Live simulation map</h3>
            </div>
          </div>
          <TravisMap
            currentVolunteer={undefined}
            onActionError={onActionError}
            selectedTurfId={selectedTurfId}
            setSelectedTurfId={setSelectedTurfId}
            turfs={turfs}
            updateVolunteerLocation={updateVolunteerLocation}
            updateVoterStatus={updateVoterStatus}
            voterPatches={voterPatches}
            voters={voters}
            volunteers={volunteers}
          />
        </section>

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
          {turfProgressRows.map(row => (
            <div
              className={row.completed ? 'complete' : ''}
              key={row.turfId}
            >
              <span>Turf {row.turfId}</span>
              <strong>{row.percent}%</strong>
              <div>
                <span
                  style={{
                    width: `${row.percent}%`,
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
            <p className="eyebrow">Local knocks</p>
            <h2>Activity feed</h2>
          </div>
        </div>
        <div className="event-feed local-feed">
          {recentEvents.length === 0 ? (
            <p className="empty-state">
              Press Simulate to start local knock events.
            </p>
          ) : (
            recentEvents.map(event => (
              <div className="event-row" key={event.id}>
                <span className={`event-type ${statusMeta(event.status).tone}`}>
                  {statusMeta(event.status).short}
                </span>
                <div>
                  <strong>{event.message}</strong>
                  <span>{relativeTime(event.createdAt)}</span>
                </div>
              </div>
            ))
          )}
          {localSimulation.completed && (
            <div className="event-row sim-complete-row">
              <span className="event-type green">OK</span>
              <div>
                <strong>All available turf queues are complete.</strong>
                <span>local simulation stopped</span>
              </div>
            </div>
          )}
        </div>
      </aside>
    </main>
  );
}

function useLocalSimulation(
  turfs: readonly Turf[],
  voters: readonly Voter[],
  stats: readonly TurfStats[],
  onActionError: (label: string, error: unknown) => void
) {
  const runtimeRef = useRef<LocalSimulationRuntime | null>(null);
  const flushTimerRef = useRef<number | null>(null);
  const [snapshot, setSnapshot] = useState<LocalSimulationSnapshot>({
    active: false,
    completed: false,
    events: [],
    startedAt: null,
    stats: [],
    ticks: 0,
    totalVolunteerMs: 0,
    voterPatches: {},
    volunteers: [],
  });

  const stop = useCallback(() => {
    const runtime = runtimeRef.current;
    if (runtime) {
      window.clearInterval(runtime.tickTimer);
      runtimeRef.current = null;
    }
    if (flushTimerRef.current) {
      window.clearInterval(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    setSnapshot(current => ({
      ...current,
      active: false,
      stats: current.stats,
      volunteers: current.volunteers.map(volunteer => ({
        ...volunteer,
        active: false,
      })),
    }));
  }, []);

  const flush = useCallback((completed = false) => {
    const runtime = runtimeRef.current;
    if (!runtime) {
      return;
    }
    refreshLocalActiveVolunteerCounts(runtime);
    setSnapshot(current => ({
      active: true,
      completed,
      events: runtime.events.slice(0, LOCAL_SIM_FEED_LIMIT),
      startedAt: current.startedAt ?? Date.now(),
      stats: Array.from(runtime.statsByTurf.values()),
      ticks: runtime.ticks,
      totalVolunteerMs: totalVolunteerTime(runtime, Date.now()),
      voterPatches: { ...runtime.voterPatches },
      volunteers: runtime.volunteers
        .slice(0, LOCAL_SIM_RENDERED_VOLUNTEER_LIMIT)
        .map(volunteer => toMapVolunteer(volunteer, Date.now())),
    }));
  }, []);

  const finish = useCallback(() => {
    const runtime = runtimeRef.current;
    if (!runtime) {
      return;
    }
    window.clearInterval(runtime.tickTimer);
    runtimeRef.current = null;
    if (flushTimerRef.current) {
      window.clearInterval(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    refreshLocalActiveVolunteerCounts(runtime);
    const finishedVolunteers = runtime.volunteers.map(volunteer => ({
      ...toMapVolunteer(volunteer, Date.now()),
      active: false,
    }));
    setSnapshot(current => ({
      active: false,
      completed: true,
      events: runtime.events.slice(0, LOCAL_SIM_FEED_LIMIT),
      startedAt: current.startedAt,
      stats: Array.from(runtime.statsByTurf.values()).map(row => ({
        ...row,
        activeVolunteerCount: runtime.baseActiveVolunteerCounts.get(row.turfId) ?? 0,
      })),
      ticks: runtime.ticks,
      totalVolunteerMs: totalVolunteerTime(runtime, Date.now()),
      voterPatches: { ...runtime.voterPatches },
      volunteers: finishedVolunteers,
    }));
  }, []);

  const start = useCallback(() => {
    stop();

    const turfIds = new Set(turfs.map(turf => turf.id));
    const votersByTurf = new Map<number, Voter[]>();
    let maxUpdatedSeq = 1;
    for (const voter of voters) {
      if (!turfIds.has(voter.turfId)) {
        continue;
      }
      const rows = votersByTurf.get(voter.turfId) ?? [];
      rows.push(voter);
      votersByTurf.set(voter.turfId, rows);
      maxUpdatedSeq = Math.max(maxUpdatedSeq, voter.updatedSeq);
    }

    const availableTurfs = turfs.filter(turf =>
      (votersByTurf.get(turf.id)?.length ?? 0) > 0
    );
    if (availableTurfs.length === 0) {
      throw new Error('No subscribed turfs or voters are ready yet');
    }

    const now = Date.now();
    const turfQueues = new Map<number, Voter[]>();
    for (const turf of availableTurfs) {
      const queue = shuffle(
        (votersByTurf.get(turf.id) ?? []).filter(
          voter => voter.status === STATUS_NOT_CONTACTED
        )
      );
      if (queue.length > 0) {
        turfQueues.set(turf.id, queue);
      }
    }

    if (turfQueues.size === 0) {
      throw new Error('All subscribed voters are already knocked');
    }

    const volunteers = Array.from(
      { length: LOCAL_SIM_VOLUNTEER_COUNT },
      (_item, index) => {
        const turf = randomItem(availableTurfs);
        const routePoint = randomItem(turf.walkRoute) ?? {
          lat: turf.centerLat,
          lng: turf.centerLng,
        };
        const volunteer: RuntimeVolunteer = {
          active: true,
          completedCount: 0,
          currentTurfId: turf.id,
          displayName: randomVolunteerName(index),
          fromLat: routePoint.lat,
          fromLng: routePoint.lng,
          heading: randomHeading(),
          id: 1_000_000 + index,
          isSimulated: true,
          lat: routePoint.lat,
          lng: routePoint.lng,
          nextKnockAt: now + randomKnockDelay(),
          targetAddress: '',
          targetDurationMs: 0,
          targetHouseholdName: '',
          targetRegisteredVoterCount: 1,
          targetVoterId: 0,
          toLat: routePoint.lat,
          toLng: routePoint.lng,
          travelStartedAt: now,
          updatedAt: localTimestamp(now),
        };
        assignNextLocalTarget(volunteer, turfQueues, availableTurfs, now);
        return volunteer;
      }
    );

    const runtime: LocalSimulationRuntime = {
      eventSeq: 1,
      events: [],
      baseActiveVolunteerCounts: buildBaseActiveVolunteerCounts(stats),
      statsByTurf: buildLocalStatsByTurf(turfs, votersByTurf, stats),
      tickTimer: 0,
      ticks: 0,
      totalCompletedVolunteerMs: 0,
      turfQueues,
      voterPatches: {},
      voterSeq: maxUpdatedSeq + 1,
      volunteers,
    };
    refreshLocalActiveVolunteerCounts(runtime);

    const runTick = () => {
      try {
        const active = runLocalSimulationTick(runtime, availableTurfs);
        flush(!active);
        if (!active) {
          finish();
        }
      } catch (error) {
        stop();
        onActionError('Local simulation tick', error);
      }
    };

    runtime.tickTimer = window.setInterval(
      runTick,
      LOCAL_SIM_TICK_MS
    );
    runtimeRef.current = runtime;
    flushTimerRef.current = window.setInterval(
      () => flush(false),
      LOCAL_SIM_FLUSH_MS
    );
    setSnapshot({
      active: true,
      completed: false,
      events: [],
      startedAt: now,
      stats: Array.from(runtime.statsByTurf.values()),
      ticks: 0,
      totalVolunteerMs: 0,
      voterPatches: {},
      volunteers: volunteers
        .slice(0, LOCAL_SIM_RENDERED_VOLUNTEER_LIMIT)
        .map(volunteer => toMapVolunteer(volunteer, now)),
    });
  }, [finish, flush, onActionError, stats, stop, turfs, voters]);

  useEffect(() => stop, [stop]);

  return { snapshot, start, stop };
}

function runLocalSimulationTick(
  runtime: LocalSimulationRuntime,
  turfs: readonly Turf[]
) {
  const now = Date.now();
  runtime.ticks += 1;
  let activeVolunteers = 0;

  for (const volunteer of runtime.volunteers) {
    if (!volunteer.active) {
      continue;
    }
    activeVolunteers += 1;
    const position = interpolatedPosition(volunteer, now);
    volunteer.lat = position.lat;
    volunteer.lng = position.lng;

    if (now < volunteer.nextKnockAt || volunteer.targetVoterId === 0) {
      continue;
    }

    const status = randomKnockStatus();
    const donationCents = status === STATUS_DONATED ? 5000 : 0;
    runtime.voterPatches[volunteer.targetVoterId] = {
      attemptCount: 1,
      donationCents,
      lastContactedAt: localTimestamp(now),
      lastContactedBy: volunteer.id,
      status,
      updatedSeq: runtime.voterSeq,
    };
    updateLocalStatsForKnock(runtime, volunteer, status, localTimestamp(now));
    runtime.totalCompletedVolunteerMs += volunteer.targetDurationMs;
    runtime.voterSeq += 1;
    volunteer.completedCount += 1;
    volunteer.lat = volunteer.toLat;
    volunteer.lng = volunteer.toLng;
    volunteer.updatedAt = localTimestamp(now);

    runtime.events.unshift({
      createdAt: localTimestamp(now),
      eventType: 'local_knock',
      id: runtime.eventSeq,
      lat: volunteer.lat,
      lng: volunteer.lng,
      message: `${volunteer.displayName} knocked ${volunteer.targetAddress}. ${
        volunteer.targetHouseholdName
      } updated: ${knockFeedLabel(status)}`,
      status,
      turfId: volunteer.currentTurfId,
      voterId: volunteer.targetVoterId,
      volunteerId: volunteer.id,
    });
    runtime.eventSeq += 1;
    runtime.events = runtime.events.slice(0, LOCAL_SIM_FEED_LIMIT);

    assignNextLocalTarget(volunteer, runtime.turfQueues, turfs, now);
    if (!volunteer.active) {
      activeVolunteers -= 1;
    }
  }

  return activeVolunteers > 0;
}

function assignNextLocalTarget(
  volunteer: RuntimeVolunteer,
  turfQueues: Map<number, Voter[]>,
  turfs: readonly Turf[],
  now: number
) {
  const queue =
    turfQueues.get(volunteer.currentTurfId)?.length
      ? turfQueues.get(volunteer.currentTurfId)
      : undefined;
  const nextQueue = queue ?? randomOpenTurfQueue(turfQueues);
  if (!nextQueue || nextQueue.length === 0) {
    volunteer.active = false;
    volunteer.targetVoterId = 0;
    return;
  }

  const voter = nextQueue.shift();
  if (!voter) {
    volunteer.active = false;
    volunteer.targetVoterId = 0;
    return;
  }

  const nextTurf = turfs.find(turf => turf.id === voter.turfId);
  volunteer.active = true;
  volunteer.currentTurfId = voter.turfId;
  volunteer.fromLat = volunteer.lat;
  volunteer.fromLng = volunteer.lng;
  volunteer.heading = headingBetween(volunteer.lat, volunteer.lng, voter.lat, voter.lng);
  volunteer.targetDurationMs = randomKnockDelay();
  volunteer.nextKnockAt = now + volunteer.targetDurationMs;
  volunteer.targetAddress = voter.address;
  volunteer.targetHouseholdName = voter.householdName;
  volunteer.targetRegisteredVoterCount = registeredVoterCount(voter);
  volunteer.targetVoterId = voter.id;
  volunteer.toLat = voter.lat;
  volunteer.toLng = voter.lng;
  volunteer.travelStartedAt = now;

  if (nextTurf && distanceBetween(volunteer.lat, volunteer.lng, voter.lat, voter.lng) === 0) {
    volunteer.fromLat = nextTurf.centerLat;
    volunteer.fromLng = nextTurf.centerLng;
  }
}

function groupVotersByTurf(voters: readonly Voter[]) {
  const votersByTurf = new Map<number, Voter[]>();
  for (const voter of voters) {
    const rows = votersByTurf.get(voter.turfId) ?? [];
    rows.push(voter);
    votersByTurf.set(voter.turfId, rows);
  }
  return votersByTurf;
}

function applyLocalVoterPatches(
  voters: readonly Voter[],
  patches: Record<number, LocalVoterPatch>
) {
  if (Object.keys(patches).length === 0) {
    return voters;
  }
  return voters.map(voter => {
    const patch = patches[voter.id];
    return patch ? { ...voter, ...patch } : voter;
  });
}

function buildLocalStatsByTurf(
  turfs: readonly Turf[],
  votersByTurf: Map<number, Voter[]>,
  stats: readonly TurfStats[]
) {
  const statsByTurf = new Map<number, TurfStats>();
  for (const row of stats) {
    statsByTurf.set(row.turfId, { ...row });
  }
  for (const turf of turfs) {
    if (!statsByTurf.has(turf.id)) {
      statsByTurf.set(turf.id, buildStatsFromVoterRows(turf.id, votersByTurf.get(turf.id) ?? []));
    }
  }
  return statsByTurf;
}

function buildStatsFromVoterRows(turfId: number, voters: readonly Voter[]): TurfStats {
  const row: TurfStats = {
    activeVolunteerCount: 0,
    contactedCount: 0,
    donatedCount: 0,
    lastEventAt: latestLocalEventTime(voters),
    literatureDroppedCount: 0,
    notContactedCount: 0,
    refusedCount: 0,
    totalVoters: 0,
    turfId,
    updateCount: 0,
  };
  for (const voter of voters) {
    const weight = registeredVoterCount(voter);
    row.totalVoters += weight;
    if (voter.status === STATUS_CONTACTED) row.contactedCount += weight;
    else if (voter.status === STATUS_LITERATURE) row.literatureDroppedCount += weight;
    else if (voter.status === STATUS_REFUSED) row.refusedCount += weight;
    else if (voter.status === STATUS_DONATED) row.donatedCount += weight;
    else row.notContactedCount += weight;
    if (voter.updatedSeq > 0) {
      row.updateCount += 1;
    }
  }
  return row;
}

function buildBaseActiveVolunteerCounts(stats: readonly TurfStats[]) {
  const counts = new Map<number, number>();
  for (const row of stats) {
    counts.set(row.turfId, row.activeVolunteerCount);
  }
  return counts;
}

function refreshLocalActiveVolunteerCounts(runtime: LocalSimulationRuntime) {
  for (const row of runtime.statsByTurf.values()) {
    row.activeVolunteerCount = runtime.baseActiveVolunteerCounts.get(row.turfId) ?? 0;
  }
  for (const volunteer of runtime.volunteers) {
    if (!volunteer.active) {
      continue;
    }
    const row = runtime.statsByTurf.get(volunteer.currentTurfId);
    if (row) {
      row.activeVolunteerCount += 1;
    }
  }
}

function updateLocalStatsForKnock(
  runtime: LocalSimulationRuntime,
  volunteer: RuntimeVolunteer,
  status: string,
  timestamp: TimeValue
) {
  const row = runtime.statsByTurf.get(volunteer.currentTurfId);
  if (!row) {
    return;
  }
  const weight = volunteer.targetRegisteredVoterCount;
  row.notContactedCount = Math.max(0, row.notContactedCount - weight);
  if (status === STATUS_CONTACTED) row.contactedCount += weight;
  else if (status === STATUS_LITERATURE) row.literatureDroppedCount += weight;
  else if (status === STATUS_REFUSED) row.refusedCount += weight;
  else if (status === STATUS_DONATED) row.donatedCount += weight;
  row.lastEventAt = timestamp;
  row.updateCount += 1;
}

function toMapVolunteer(volunteer: RuntimeVolunteer, now: number): MapVolunteer {
  const position = interpolatedPosition(volunteer, now);
  return {
    active: volunteer.active,
    completedCount: volunteer.completedCount,
    currentTurfId: volunteer.currentTurfId,
    displayName: volunteer.displayName,
    heading: volunteer.heading,
    id: volunteer.id,
    isSimulated: volunteer.isSimulated,
    lat: position.lat,
    lng: position.lng,
    targetVoterId: volunteer.targetVoterId,
    updatedAt: volunteer.updatedAt,
  };
}

function interpolatedPosition(volunteer: RuntimeVolunteer, now: number) {
  const duration = Math.max(1, volunteer.nextKnockAt - volunteer.travelStartedAt);
  const progress = Math.min(1, Math.max(0, (now - volunteer.travelStartedAt) / duration));
  return {
    lat: volunteer.fromLat + (volunteer.toLat - volunteer.fromLat) * progress,
    lng: volunteer.fromLng + (volunteer.toLng - volunteer.fromLng) * progress,
  };
}

function totalVolunteerTime(runtime: LocalSimulationRuntime, now: number) {
  const activeVolunteerMs = runtime.volunteers.reduce((sum, volunteer) => {
    if (!volunteer.active || volunteer.targetVoterId === 0) {
      return sum;
    }
    const elapsed = Math.min(
      volunteer.targetDurationMs,
      Math.max(0, now - volunteer.travelStartedAt)
    );
    return sum + elapsed;
  }, 0);
  return runtime.totalCompletedVolunteerMs + activeVolunteerMs;
}

function randomOpenTurfQueue(turfQueues: Map<number, Voter[]>) {
  const openQueues = [...turfQueues.values()].filter(queue => queue.length > 0);
  return openQueues.length > 0 ? randomItem(openQueues) : undefined;
}

function randomKnockDelay() {
  return randomInt(LOCAL_SIM_MIN_KNOCK_MS, LOCAL_SIM_MAX_KNOCK_MS);
}

function randomKnockStatus() {
  const roll = Math.random();
  if (roll < 0.85) return STATUS_LITERATURE;
  if (roll < 0.95) return STATUS_CONTACTED;
  if (roll < 0.99) return STATUS_REFUSED;
  return STATUS_DONATED;
}

function knockFeedLabel(status: string) {
  if (status === STATUS_LITERATURE) return 'Lit drop';
  if (status === STATUS_CONTACTED) return 'Contacted';
  if (status === STATUS_REFUSED) return 'Refused';
  if (status === STATUS_DONATED) return 'Donated';
  return statusMeta(status).label;
}

function randomVolunteerName(index: number) {
  return `${randomItem(FIRST_NAMES)} ${randomItem(LAST_NAMES)} ${index + 1}`;
}

function randomHeading() {
  return Math.random() * Math.PI * 2;
}

function headingBetween(latA: number, lngA: number, latB: number, lngB: number) {
  return Math.atan2(latB - latA, lngB - lngA);
}

function randomInt(min: number, max: number) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function randomItem<T>(items: readonly T[]) {
  return items[Math.floor(Math.random() * items.length)];
}

function shuffle<T>(items: readonly T[]) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function localTimestamp(ms: number): TimeValue {
  return Timestamp.fromDate(new Date(ms));
}

function formatVolunteerTime(ms: number) {
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours >= 1000) {
    return `${Math.round(hours / 100) / 10}k h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

function latestLocalEventTime(voters: readonly Voter[]) {
  const latest = voters.reduce((max, voter) => {
    const time = voter.lastContactedAt?.toDate?.().getTime() ?? 0;
    return Math.max(max, time);
  }, 0);
  return latest > 0 ? localTimestamp(latest) : undefined;
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
  value: number | string;
}) {
  return (
    <div className={`metric ${accent ?? ''}`}>
      <span>{label}</span>
      <strong>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </strong>
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
    },
    {
      count: contacted + donated,
      label: 'Contacted',
      status: STATUS_CONTACTED,
    },
    {
      count: refused,
      label: 'Refused',
      status: STATUS_REFUSED,
    },
    {
      count: donated,
      label: 'Donated',
      status: STATUS_DONATED,
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

function buildTurfProgressRows(stats: readonly TurfStats[]) {
  return stats
    .map(row => {
      const knocked = Math.max(0, row.totalVoters - row.notContactedCount);
      const percent =
        row.totalVoters > 0
          ? Math.round((knocked / row.totalVoters) * 100)
          : 0;
      return {
        completed: percent >= 100,
        percent,
        turfId: row.turfId,
      };
    })
    .sort((a, b) => {
      if (a.completed !== b.completed) {
        return a.completed ? 1 : -1;
      }
      if (a.percent !== b.percent) {
        return b.percent - a.percent;
      }
      return b.turfId - a.turfId;
    });
}

function buildLiveTelemetry(
  events: readonly ActivityEvent[],
  stats: readonly TurfStats[],
  turfs: readonly Turf[],
  voters: readonly Voter[],
  volunteers: readonly MapVolunteer[]
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
  let maxLat = 30.628;
  let maxLng = -97.37;
  let minLat = 30.024;
  let minLng = -98.173;
  for (const turf of turfs) {
    for (const point of turf.boundary) {
      maxLat = Math.max(maxLat, point.lat);
      maxLng = Math.max(maxLng, point.lng);
      minLat = Math.min(minLat, point.lat);
      minLng = Math.min(minLng, point.lng);
    }
  }
  return {
    maxLat,
    maxLng,
    minLat,
    minLng,
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

function mapVoterColor(voter: Voter) {
  return voter.status === STATUS_NOT_CONTACTED
    ? '#8f9792'
    : statusMeta(voter.status).color;
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
