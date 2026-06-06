import {
  DbConnectionBuilder,
  DbConnectionImpl,
  SubscriptionBuilderImpl,
  procedures,
  reducerSchema,
  reducers,
  schema,
  t,
  table,
} from 'spacetimedb';

export const STATUS_NOT_CONTACTED = 'not_contacted';
export const STATUS_CONTACTED = 'contacted';
export const STATUS_LITERATURE = 'literature_dropped';
export const STATUS_REFUSED = 'refused';
export const STATUS_DONATED = 'donated';

export const defaultHost =
  process.env.SPACETIMEDB_HOST ?? 'https://maincloud.spacetimedb.com';
export const defaultDatabase =
  process.env.SPACETIMEDB_DB_NAME ??
  process.env.SPACETIMEDB_DB_ID ??
  'spacecanvas-5rvak';

const Coordinate = t.object('Coordinate', {
  lat: t.f64(),
  lng: t.f64(),
});

const RegisteredVoterImportRow = t.object('RegisteredVoterImportRow', {
  vuid: t.string(),
  payload: t.string(),
});

const tablesSchema = schema({
  turf: table(
    { name: 'turf', indexes: [], constraints: [] },
    t.row({
      id: t.u32().primaryKey(),
      name: t.string(),
      neighborhood: t.string(),
      center_lat: t.f64(),
      center_lng: t.f64(),
      boundary: t.array(Coordinate),
      walk_route: t.array(Coordinate),
    })
  ),
  voter: table(
    {
      name: 'voter',
      indexes: [
        { accessor: 'by_turf', algorithm: 'btree', columns: ['turf_id'] },
        { accessor: 'by_status', algorithm: 'btree', columns: ['status'] },
      ],
      constraints: [],
    },
    t.row({
      id: t.u32().primaryKey(),
      turf_id: t.u32(),
      household_key: t.option(t.string()),
      registered_voter_count: t.option(t.u32()),
      household_name: t.string(),
      address: t.string(),
      precinct: t.option(t.string()),
      source_city: t.option(t.string()),
      source_zip_5: t.option(t.string()),
      lat: t.f64(),
      lng: t.f64(),
      status: t.string(),
      last_contacted_at: t.option(t.timestamp()),
      last_contacted_by: t.option(t.u32()),
      attempt_count: t.u16(),
      donation_cents: t.u32(),
      updated_seq: t.u32(),
    })
  ),
  volunteer: table(
    {
      name: 'volunteer',
      indexes: [
        { accessor: 'by_identity', algorithm: 'btree', columns: ['identity'] },
        { accessor: 'by_turf', algorithm: 'btree', columns: ['current_turf_id'] },
        { accessor: 'by_simulated', algorithm: 'btree', columns: ['is_simulated'] },
      ],
      constraints: [],
    },
    t.row({
      id: t.u32().primaryKey(),
      identity: t.identity(),
      display_name: t.string(),
      current_turf_id: t.u32(),
      lat: t.f64(),
      lng: t.f64(),
      heading: t.f64(),
      active: t.bool(),
      is_simulated: t.bool(),
      target_voter_id: t.u32(),
      completed_count: t.u32(),
      updated_at: t.timestamp(),
    })
  ),
  activityEvent: table(
    {
      name: 'activity_event',
      indexes: [
        { accessor: 'by_turf', algorithm: 'btree', columns: ['turf_id'] },
        { accessor: 'by_created_at', algorithm: 'btree', columns: ['created_at'] },
      ],
      constraints: [],
    },
    t.row({
      id: t.u32().primaryKey(),
      turf_id: t.u32(),
      voter_id: t.option(t.u32()),
      volunteer_id: t.option(t.u32()),
      event_type: t.string(),
      status: t.string(),
      message: t.string(),
      lat: t.f64(),
      lng: t.f64(),
      created_at: t.timestamp(),
    })
  ),
  turfStats: table(
    { name: 'turf_stats', indexes: [], constraints: [] },
    t.row({
      turf_id: t.u32().primaryKey(),
      total_voters: t.u32(),
      not_contacted_count: t.u32(),
      contacted_count: t.u32(),
      literature_dropped_count: t.u32(),
      refused_count: t.u32(),
      donated_count: t.u32(),
      active_volunteer_count: t.u32(),
      update_count: t.u32(),
      last_event_at: t.option(t.timestamp()),
    })
  ),
  simState: table(
    { name: 'sim_state', indexes: [], constraints: [] },
    t.row({
      id: t.u32().primaryKey(),
      enabled: t.bool(),
      virtual_volunteers: t.u32(),
      cursor: t.u32(),
      ticks: t.u32(),
      events_emitted: t.u32(),
      updated_at: t.timestamp(),
    })
  ),
  registeredVoter: table(
    {
      name: 'registered_voter',
      indexes: [
        { accessor: 'by_status', algorithm: 'btree', columns: ['status'] },
        { accessor: 'by_city', algorithm: 'btree', columns: ['city'] },
      ],
      constraints: [],
    },
    t.row({
      vuid: t.string().primaryKey(),
      name: t.string(),
      status: t.string(),
      city: t.string(),
      zip5: t.string(),
      precinct: t.string(),
      payload: t.string(),
    })
  ),
});

const reducersSchema = reducers(
  reducerSchema('import_registered_voters', {
    rows: t.array(RegisteredVoterImportRow),
  }),
  reducerSchema('reset_demo_data', {}),
  reducerSchema('claim_turf', {
    displayName: t.string(),
    preferredTurfId: t.u32(),
  }),
  reducerSchema('update_volunteer_location', {
    volunteerId: t.u32(),
    lat: t.f64(),
    lng: t.f64(),
    heading: t.f64(),
  }),
  reducerSchema('update_voter_status', {
    voterId: t.u32(),
    status: t.string(),
    volunteerId: t.u32(),
    lat: t.f64(),
    lng: t.f64(),
    donationCents: t.u32(),
  }),
  reducerSchema('complete_turf', { volunteerId: t.u32() }),
  reducerSchema('seed_simulation', { volunteerCount: t.u32() }),
  reducerSchema('stop_simulation', {}),
  reducerSchema('simulate_tick', { batchSize: t.u32() })
);

const REMOTE_MODULE = {
  versionInfo: { cliVersion: '2.0.0' },
  tables: tablesSchema.schemaType.tables,
  reducers: reducersSchema.reducersType.reducers,
  ...procedures(),
};

export class SubscriptionBuilder extends SubscriptionBuilderImpl {}

export class DbConnection extends DbConnectionImpl {
  static builder() {
    return new DbConnectionBuilder(
      REMOTE_MODULE,
      config => new DbConnection(config)
    );
  }

  subscriptionBuilder() {
    return new SubscriptionBuilder(this);
  }
}
