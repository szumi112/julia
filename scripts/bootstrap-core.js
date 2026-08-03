import {
  blindEmailIndex,
  createWrappedDataKey,
  decryptForScope,
  encryptForScope,
} from '../worker/security/envelope.js'
import { accessDesiredFingerprint } from '../worker/jobs/access-reconciliation.js'
import { retryDelayMs } from '../worker/jobs/outbox.js'

const DAY_MS = 86_400_000
const OUTBOX_LEASE_MS = 60_000
const EMPTY_FINGERPRINT = 'BYDlKyUUBNO-3cX7_bRPY-TkArudTPGjIdbwtAdLSCw'
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const STAFF_ID = /^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const INVITATION_ID = /^inv_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const SPECIALIST_ID = /^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const LOOKUP = /^v1:[A-Za-z0-9_-]{43}$/

const MIGRATIONS = Object.freeze([
  '0001_security_primitives.sql',
  '0002_identity_operations.sql',
  '0003_rate_limit_guard.sql',
  '0004_staff_provisioning_state.sql',
  '0005_outbox_operation_guard.sql',
  '0006_delivery_attempt_uniqueness.sql',
  '0007_operational_health_indexes.sql',
  '0008_outbox_drain_heartbeat.sql',
  '0009_core_directory_expand.sql',
])

const TABLE_COLUMNS = Object.freeze({
  audit_events: ['id', 'occurred_at', 'actor_staff_id', 'action', 'entity_type', 'entity_id', 'result', 'reason_envelope', 'correlation_id', 'metadata_json'],
  backup_runs: ['id', 'local_day', 'local_month', 'retention_class', 'status', 'version', 'export_bookmark', 'object_key', 'manifest_key', 'ssec_key_version', 'wrapped_ssec_key_b64', 'wrap_nonce_b64', 'object_etag', 'object_size', 'started_at', 'completed_at', 'expires_at', 'restore_verified_at', 'last_error_code', 'created_at', 'updated_at'],
  client_assignments: ['id', 'client_id', 'specialist_id', 'starts_at', 'ends_at', 'assigned_by_staff_id', 'version', 'created_at', 'updated_at'],
  clients: ['id', 'identity_envelope', 'status', 'version', 'archived_at', 'created_at', 'updated_at'],
  data_keys: ['id', 'scope_type', 'scope_id', 'purpose', 'dek_version', 'wrapped_key_b64', 'wrap_nonce_b64', 'kek_version', 'created_at', 'retired_at'],
  delivery_attempts: ['id', 'outbox_job_id', 'provider', 'provider_reference', 'status', 'error_code', 'attempted_at'],
  idempotency_records: ['actor_id', 'operation', 'idempotency_key', 'request_hash', 'resource_type', 'resource_id', 'response_envelope', 'created_at', 'expires_at'],
  operational_actions: ['id', 'fingerprint', 'kind', 'severity', 'status', 'entity_type', 'entity_id', 'details_envelope', 'version', 'created_at', 'updated_at', 'resolved_at'],
  outbox_attempts: ['id', 'job_id', 'attempt_number', 'started_at', 'completed_at', 'result', 'error_code', 'provider_reference'],
  outbox_jobs: ['id', 'type', 'aggregate_type', 'aggregate_id', 'payload_envelope', 'idempotency_key', 'status', 'attempt_count', 'max_attempts', 'scheduled_at', 'lease_owner', 'lease_expires_at', 'last_error_code', 'created_at', 'updated_at'],
  record_versions: ['id', 'entity_type', 'entity_id', 'version', 'snapshot_envelope', 'changed_by_staff_id', 'changed_at', 'correlation_id'],
  scheduler_runs: ['id', 'scheduled_for', 'started_at', 'completed_at', 'status', 'attempt_count', 'lease_owner', 'lease_expires_at', 'claimed_jobs', 'succeeded_jobs', 'failed_jobs', 'error_code'],
  specialists: ['id', 'staff_user_id', 'standard_rate_grosze', 'status', 'version', 'archived_at', 'created_at', 'updated_at'],
  staff_invitations: ['id', 'staff_id', 'email_lookup', 'email_envelope', 'display_name_envelope', 'role', 'status', 'inviter_id', 'expires_at', 'access_allowed_at', 'email_sent_at', 'activated_at', 'revoked_at', 'version', 'created_at', 'updated_at'],
  staff_users: ['id', 'email_lookup', 'email_envelope', 'display_name_envelope', 'role', 'status', 'access_subject', 'specialist_id', 'version', 'activated_at', 'disabled_at', 'created_at', 'updated_at'],
  system_state: ['key', 'value_json', 'version', 'updated_at'],
})

const TABLE_HASHES = Object.freeze({
  audit_events: 'c33269b506c3f32e5eaaf335f673a4a48796f00803ae66c0e4e47a4f382bb67a',
  backup_runs: '83798b62670f65ce4c2ac7554929a845de6ed0b84294e0a68a73212e6225300f',
  client_assignments: '1b4c8592ee76cbc16b16148a4329582abd6ab19db656e0f9c5faee47f3e85b52',
  clients: '1797147c34044537f9837b35c4b96c18bca70ef574e337ffc41d9e0f365d6878',
  data_keys: '5e7b7a2f3853932e8dce56f06542abf77a4366a592f9b28969d9433139a9eb9c',
  delivery_attempts: 'bed3635d67f1b5bc58dff7f1ce791b9ab504776cd51c9e85a549ca1cadb37f44',
  idempotency_records: '77bb61a97c5f389b44e143039992c828ab860ad832701cf80deb678c73934fd6',
  operational_actions: '6e7ec96f92628a932de2ee5a163e8d86c5efb61766053d006b2a229ba4aa7122',
  outbox_attempts: '1974b7495d8709aa1656681e7ea22089ced58c8aa10c63a95bcfd3d6f43a5cf7',
  outbox_jobs: 'c051a990477ff5efb82dc932d31eead7b8d15ae59b82e510c332f271537884e3',
  record_versions: 'a185ba59472d5a30d12b6f272b3c020b6b268fa6815340eb0c65892a34d10268',
  scheduler_runs: '353996a0511950d5f24aa1eb1b7f05c0fa816ef02783c3378cf1c8d265cece63',
  specialists: 'a362be8a0c6f09553caecdfcd16f9aa2b6ccf8e783bddc2a07892e9e916be843',
  staff_invitations: 'fe26c54a624d40f6061d5a6dac5233d883cd5abb2e7ca70c52b6bd178e57e07a',
  staff_users: '9df5280cca36b562d4d59142ffa116d6a1d175a855393b291688e12cde6a98af',
  system_state: '14394863ce7d8bd0af6239e90df21cbe07b4603e48a19502e08a64374a8b8ecb',
})

const REQUIRED_TRIGGERS = Object.freeze([
  'audit_events_identity_collision',
  'audit_events_no_delete',
  'audit_events_no_update',
  'backup_runs_identity_collision',
  'backup_runs_immutable_identity',
  'backup_runs_no_delete',
  'backup_runs_update_identity_collision',
  'backup_runs_valid_transition',
  'backup_runs_version_increment',
  'client_assignments_identity_collision',
  'client_assignments_immutable_identity',
  'client_assignments_no_delete',
  'client_assignments_valid_close',
  'client_assignments_version_increment',
  'clients_identity_collision',
  'clients_immutable_identity',
  'clients_no_delete',
  'clients_valid_transition',
  'clients_version_increment',
  'core_directory_invariant_failure',
  'data_keys_identity_collision',
  'data_keys_immutable_identity',
  'data_keys_immutable_retirement',
  'data_keys_initially_active',
  'data_keys_no_delete',
  'data_keys_valid_rewrap',
  'delivery_attempts_identity_collision',
  'delivery_attempts_no_delete',
  'delivery_attempts_no_update',
  'idempotency_records_identity_collision',
  'idempotency_records_no_delete',
  'idempotency_records_no_update',
  'operational_actions_identity_collision',
  'operational_actions_immutable_identity',
  'operational_actions_no_delete',
  'operational_actions_update_identity_collision',
  'operational_actions_version_increment',
  'outbox_attempts_identity_collision',
  'outbox_attempts_immutable_identity',
  'outbox_attempts_no_delete',
  'outbox_attempts_valid_completion',
  'outbox_jobs_identity_collision',
  'outbox_jobs_immutable_identity',
  'outbox_jobs_no_delete',
  'outbox_jobs_update_identity_collision',
  'outbox_jobs_valid_transition',
  'outbox_operation_guard_failure',
  'rate_limit_guard_failure',
  'record_versions_identity_collision',
  'record_versions_no_delete',
  'record_versions_no_update',
  'scheduler_runs_identity_collision',
  'scheduler_runs_immutable_identity',
  'scheduler_runs_no_delete',
  'scheduler_runs_update_identity_collision',
  'scheduler_runs_valid_transition',
  'specialists_identity_collision',
  'specialists_immutable_identity',
  'specialists_no_delete',
  'specialists_version_increment',
  'staff_invitations_identity_collision',
  'staff_invitations_immutable_identity',
  'staff_invitations_no_delete',
  'staff_invitations_update_identity_collision',
  'staff_invitations_valid_transition',
  'staff_invitations_version_increment',
  'staff_users_identity_collision',
  'staff_users_immutable_identity',
  'staff_users_keep_last_owner',
  'staff_users_no_delete',
  'staff_users_update_identity_collision',
  'staff_users_version_increment',
  'system_state_identity_collision',
  'system_state_immutable_identity',
  'system_state_no_delete',
  'system_state_version_increment',
])

const TRIGGER_HASHES = Object.freeze({
  audit_events_identity_collision: '3b41e5008a2416469580975d9944bcd00cbcf250453d8647e8fa9760e7862e9b',
  audit_events_no_delete: 'c369521a215c414492439abf558d7079ca7bd13f6091579f4bd8f94b66227509',
  audit_events_no_update: '230e61aabdac4e6cee6d99bd07648ca3c5eb61f2019ce99647d6450c93aa93c0',
  backup_runs_identity_collision: '27b5ae4bfc9a35382a4c6e0e2cc12116055cda174abf91d46c164f22b8b92757',
  backup_runs_immutable_identity: 'ddaede2625338d1076999ae419087ffe01a065f9f96499c86aded2474189ec8d',
  backup_runs_no_delete: 'a236b9bb0aeab9edb7fc55accc65968a86a80b5d78f8c982f8783a70bb02d973',
  backup_runs_update_identity_collision: '4331f609472e85a759ad0aabb5094f79452da70d791e4d148b9b05c50b264198',
  backup_runs_valid_transition: 'd78b161dc3fd4268d011f1fd532316c65254eacf00589f9dc3481963c3c24fa4',
  backup_runs_version_increment: 'ad5247d8bc5ebb4c2db90b7357c5fadd0e74f0e82fe1ca3824899293610783e9',
  client_assignments_identity_collision: 'b070063724c9c930f3d704021c358ebbeb196fd999fc90cf1c41994b35422c31',
  client_assignments_immutable_identity: 'f250e1a68cc8851288945617fd14ffb599139b5fe8bc37905bf3a02ddddd9df4',
  client_assignments_no_delete: 'f384d9d6a8cf129421cc1593f0b3730b558f9a6c02ebe6fb22b818774972c0d0',
  client_assignments_valid_close: '14da202a7e16fdd0cf2fab2c4a0dceec91deff5ea1796a4a74889f9c88f21b1e',
  client_assignments_version_increment: '4209acadb73d02fc594a364acc127d62057a064a56dd5396685ccda5ae3106cf',
  clients_identity_collision: 'aa66580ad0488d5189e31b308240e5b3007c123416cb13b5618227273b61e84c',
  clients_immutable_identity: '2f0f48e28155d2aaa8a91d45cf440ad5020168341e9db2304c5f7c81d5cff8c2',
  clients_no_delete: '529d05614952a610b3d9433e0adf09c0f7f573089c5c2ec794b4d6b7b73e03ac',
  clients_valid_transition: '3e7236734f88594b4d2dd1fa017ebf1f68353e25b15e6a11c39a2f0b7579da9a',
  clients_version_increment: 'afe74455b38730f59b613d60d0bc8f42ddaf473d0fc9fc6d7f52d3b1f0072aa2',
  core_directory_invariant_failure: 'ec6314a1dc791670e337122215153a35da2300c48dcc7373e38c8bca7ec8f5ee',
  data_keys_identity_collision: '61bd71c00bb44d3c36bf3ff9284850cad5451d1b4749dc42d1cc9ea160b9965a',
  data_keys_immutable_identity: 'ca7342a503f8a1c9c6b9df32974918949337ecf1403bf6c1574914a665797ec5',
  data_keys_immutable_retirement: '72a9c9a2f0b3fcf198c24aed3ef11072db52ea7d9d81b784ecace3b295a979d6',
  data_keys_initially_active: 'bc418413cdc2348eaaa01eae8e1a93b4b76e96f8b6c05c4ec9f617ec8d3a67d0',
  data_keys_no_delete: '38abb2df3fce8fb82764218e582970c97193a87667f3a401faf4de5d3542ee26',
  data_keys_valid_rewrap: '96dc72a66902b64db17cc964176a98b62dceb4a6da7c60597820a087d9e7caf8',
  delivery_attempts_identity_collision: 'f632f0e506bbe126c8435de347e9ea0191c61ae0219ab3687f4d98f7347007d0',
  delivery_attempts_no_delete: '4e3b1de9ddbca60852c478e4f076b54f889a2efdf4e0d9a93d591b9f33024d03',
  delivery_attempts_no_update: '5351ea71c770a3712b73fccf1c49a3f7d6876bec1ba9f13b836f9bae7e92bbca',
  idempotency_records_identity_collision: '95f7717a1397f9e17f5e315e60e7d2a43a471f73b4931fd6c20b64bdf62d9757',
  idempotency_records_no_delete: '62362bac00f59d2d2e0611e31801027dd79b55c06194f04a76b3e2e672596b08',
  idempotency_records_no_update: '0bb6e91fedcbc9e6866fa5be46dcdb07946e907b1cfb4b83307d13737aa62ab0',
  operational_actions_identity_collision: '1deeeb223f8f82fbb19851be278088e76c63d1baa152abe1cc6fba346a308717',
  operational_actions_immutable_identity: '0d6cb053ca742e2e57e41ede5f134080995378e668f825c5512e0310e11ff624',
  operational_actions_no_delete: 'c8d05fdea1861988eee13b2f39936b92be30c7ee91bd6e37c0364d78c4363d67',
  operational_actions_update_identity_collision: 'b39d8508ae572df0daaaaef1494dea4a22823aa722433409510758fa89be533d',
  operational_actions_version_increment: '2de9729ba23f42bf0e139222e5604ffc26b05c53cd6ef32d00973f6fea1be626',
  outbox_attempts_identity_collision: '7198ceab3add1a6edde2069860b8da8f364d4ab9b2e28c4ba717de2d660e3be6',
  outbox_attempts_immutable_identity: 'dbda35dfb86f16501beb93d5b5c60dd9c8b0a427cc4d7fb168ef3404d61b2e0b',
  outbox_attempts_no_delete: 'af57d1f25c388c5fc5b03e8856c664ba6d1c3ac43c640cf54120869d958faeb3',
  outbox_attempts_valid_completion: '5cc0bd810027eb0987c2db8fa8dc1703a78b9b945c7ef45e80ddff9bdce70fcc',
  outbox_jobs_identity_collision: '4bf2257b9ff12a6519eb605ada8fb4791c2146991ea25d634168ef37bf25b4ab',
  outbox_jobs_immutable_identity: '43d0bdc55fb509ab4ed7cf999ae5fe4cc4979dad1d80b1cab6ca4f40b877a59d',
  outbox_jobs_no_delete: '34a17da09f29d7ab5c90b6474fbb46d99d8fecffd652aa308c3dc53b14b060a3',
  outbox_jobs_update_identity_collision: '20fe80044b0059f757707767b60ce874797d8c9d2d6d65d9e950c5250cdfd9d1',
  outbox_jobs_valid_transition: '408b97dca427241a91011ce6dc8bf676fe0054be37022601764fef0e5cd8e2f2',
  outbox_operation_guard_failure: '034b2214bac8f6ffa4f4b13b44ccce09cde138ae3985ab5f7ead72949158f544',
  rate_limit_guard_failure: '1a92c4f1f82af5a908460f49319db2a06efd43c11a2272abdb266947246c075f',
  record_versions_identity_collision: '6968d157c9de6d3986c6e910711b3b99e5902ae905a6563f84b221d0b24cb050',
  record_versions_no_delete: '4c24eb0c2ad469231d1f48b2b02f53d6cdf9ab1f4cd6dd2911f97f4d1fb3f403',
  record_versions_no_update: 'c29e6057138f7c606b6cb022a104801c0d6547ed562285920baedaef838899ee',
  scheduler_runs_identity_collision: '42006da41758fbef9cb3329abbdabc44e2465b7357b2cbcc2d32ba939e9346a7',
  scheduler_runs_immutable_identity: '742c7ab02af9d1e047286537a1fa71ec358b3b3e944a49219144c3135c87102b',
  scheduler_runs_no_delete: '59d2243c00ec77049971aef080f9e9d0069d205ea2b45fcad938353476bedb94',
  scheduler_runs_update_identity_collision: '8b9a92dda30de41290747921f6b9171e86c0844ba5d9c6d671cd517e1e40cf48',
  scheduler_runs_valid_transition: '7879e4a5cc160da27bb2cb7a45047b6d5b53709a476541975407a774f0a40790',
  specialists_identity_collision: '72961249fb080ec9cdbb2e4dd5b18e2a9683423d12f87a3d209bca6c5038e119',
  specialists_immutable_identity: '944e014f8ae045721bb02a80a21fee0c55864a70454c59833be2c30479736aa7',
  specialists_no_delete: '10a7b55e857ed212073519966dcd304f64cf4f7abbc93fa65729e4ef6f2476af',
  specialists_version_increment: '05efb3ba06442c5661f8c59293f530734fd22dc6ee1c7b5bb3518801a188eb65',
  staff_invitations_identity_collision: 'a0f3304f21b583febe67f22efc478d8bc107c7e014ebafb498dfef1e933a5803',
  staff_invitations_immutable_identity: 'd48590f91b878b6c6ed45c8dd1f18039067d71bef79777dcedf2922f7213a8cd',
  staff_invitations_no_delete: '2ecc6f9eb3f51ca6499dbb9658b4d9fa9c4b7d1857eec04842a18656b99ce802',
  staff_invitations_update_identity_collision: '66e8f5c1b06740123dac3d28e844f5aa1a24e119ada078ffef7b901ffb837968',
  staff_invitations_valid_transition: 'ea312852c77fcc7e63b34cc0cf55d2dd49b70fda84a3e17dd4b06fb7ad6a1dea',
  staff_invitations_version_increment: '25fc6a6d98b27ff01cc3ae62860153acd91369e57a0ce180d1a6e39c5ae3de3c',
  staff_users_identity_collision: '89b2c7abd67e7e5dac71d0a89f84214beacdb8699d06ffc0e191c8121c99eb3b',
  staff_users_immutable_identity: '406106fe6cf31ee2ac2f8e99c116d2c7e4c0923f4372a5408212d7f14ae6a0c5',
  staff_users_keep_last_owner: 'b9a795315db627e716634e676f0b796fda57d80db860711e2fb789d6750ddef1',
  staff_users_no_delete: '959b4e7055c229d88952c2a41b84128bacd152f0516c3cd78be894c99e75502f',
  staff_users_update_identity_collision: '6eeaa7125f3f8e654adcbc99cd19c100a835f9dec0203c1f5ad21a5174bdfb0c',
  staff_users_version_increment: '0cbfce818eaf53b79d53bad940d56b84dca07796a27b54a99456e7324168b9ae',
  system_state_identity_collision: '2804d378c490deefec6ea85ada39219e4f3b6fc42d0bd78dcce4ac342e69d6fd',
  system_state_immutable_identity: 'f955f46c522859c45df0a57428273ca0d37be5c2ca58e0c40372c1c1ad0053b4',
  system_state_no_delete: '7037a9b51130bdd1ceafff588c090f17310550616bdbd91b791e2c3e490ab370',
  system_state_version_increment: '9d96fe57cf7102c3356d9bc72d6c301960ba27b1f628a5c758abf26087332dc8',
})

const REQUIRED_VIEWS = Object.freeze({
  core_directory_invariant_failures: 'CREATE VIEW core_directory_invariant_failures (failure_kind) AS SELECT CAST(NULL AS TEXT) WHERE 0',
  outbox_operation_guard_failures: "CREATE VIEW outbox_operation_guard_failures (operation_id) AS SELECT id FROM outbox_jobs WHERE 0",
  rate_limit_guard_failures: "CREATE VIEW rate_limit_guard_failures (audit_id) AS SELECT id FROM audit_events WHERE 0",
})

const DELIVERY_INDEX = Object.freeze({
  name: 'delivery_attempts_outbox_job_id_idx',
  sql: 'CREATE UNIQUE INDEX delivery_attempts_outbox_job_id_idx ON delivery_attempts (outbox_job_id)',
})

const REQUIRED_INDEXES = Object.freeze([
  Object.freeze({
    name: 'client_assignments_open_client_idx',
    sql: 'CREATE UNIQUE INDEX client_assignments_open_client_idx ON client_assignments(client_id) WHERE ends_at IS NULL',
    columns: Object.freeze([
      Object.freeze({ cid: 1, name: 'client_id', seqno: 0 }),
    ]),
    partial: 1,
    table: 'client_assignments',
    unique: 1,
  }),
  Object.freeze({
    name: 'client_assignments_specialist_ends_client_idx',
    sql: 'CREATE INDEX client_assignments_specialist_ends_client_idx ON client_assignments(specialist_id,ends_at,client_id)',
    columns: Object.freeze([
      Object.freeze({ cid: 2, name: 'specialist_id', seqno: 0 }),
      Object.freeze({ cid: 4, name: 'ends_at', seqno: 1 }),
      Object.freeze({ cid: 1, name: 'client_id', seqno: 2 }),
    ]),
    partial: 0,
    table: 'client_assignments',
    unique: 0,
  }),
  Object.freeze({
    ...DELIVERY_INDEX,
    columns: Object.freeze([
      Object.freeze({ cid: 1, name: 'outbox_job_id', seqno: 0 }),
    ]),
    partial: 0,
    table: 'delivery_attempts',
    unique: 1,
  }),
  Object.freeze({
    name: 'backup_runs_created_id_idx',
    sql: 'CREATE INDEX backup_runs_created_id_idx ON backup_runs(created_at DESC,id DESC)',
    columns: Object.freeze([
      Object.freeze({ cid: 19, name: 'created_at', seqno: 0 }),
      Object.freeze({ cid: 0, name: 'id', seqno: 1 }),
    ]),
    partial: 0,
    table: 'backup_runs',
    unique: 0,
  }),
  Object.freeze({
    name: 'backup_runs_success_completed_id_idx',
    sql: "CREATE INDEX backup_runs_success_completed_id_idx ON backup_runs(completed_at DESC,id DESC) WHERE status IN('stored','restore_verified')",
    columns: Object.freeze([
      Object.freeze({ cid: 15, name: 'completed_at', seqno: 0 }),
      Object.freeze({ cid: 0, name: 'id', seqno: 1 }),
    ]),
    partial: 1,
    table: 'backup_runs',
    unique: 0,
  }),
  Object.freeze({
    name: 'operational_actions_resolved_fingerprint_at_id_idx',
    sql: "CREATE INDEX operational_actions_resolved_fingerprint_at_id_idx ON operational_actions(fingerprint,resolved_at DESC,id DESC) WHERE status='resolved'",
    columns: Object.freeze([
      Object.freeze({ cid: 1, name: 'fingerprint', seqno: 0 }),
      Object.freeze({ cid: 11, name: 'resolved_at', seqno: 1 }),
      Object.freeze({ cid: 0, name: 'id', seqno: 2 }),
    ]),
    partial: 1,
    table: 'operational_actions',
    unique: 0,
  }),
  Object.freeze({
    name: 'outbox_jobs_ordinary_status_updated_id_idx',
    sql: "CREATE INDEX outbox_jobs_ordinary_status_updated_id_idx ON outbox_jobs(status,updated_at DESC,id DESC) WHERE type IN('staff.access.reconcile','staff.invitation.email','staff.invitation.expire')",
    columns: Object.freeze([
      Object.freeze({ cid: 6, name: 'status', seqno: 0 }),
      Object.freeze({ cid: 14, name: 'updated_at', seqno: 1 }),
      Object.freeze({ cid: 0, name: 'id', seqno: 2 }),
    ]),
    partial: 1,
    table: 'outbox_jobs',
    unique: 0,
  }),
  Object.freeze({
    name: 'scheduler_runs_status_completed_id_idx',
    sql: 'CREATE INDEX scheduler_runs_status_completed_id_idx ON scheduler_runs(status,completed_at DESC,id DESC)',
    columns: Object.freeze([
      Object.freeze({ cid: 4, name: 'status', seqno: 0 }),
      Object.freeze({ cid: 3, name: 'completed_at', seqno: 1 }),
      Object.freeze({ cid: 0, name: 'id', seqno: 2 }),
    ]),
    partial: 0,
    table: 'scheduler_runs',
    unique: 0,
  }),
  Object.freeze({
    name: 'specialists_status_id_idx',
    sql: 'CREATE INDEX specialists_status_id_idx ON specialists(status,id)',
    columns: Object.freeze([
      Object.freeze({ cid: 3, name: 'status', seqno: 0 }),
      Object.freeze({ cid: 0, name: 'id', seqno: 1 }),
    ]),
    partial: 0,
    table: 'specialists',
    unique: 0,
  }),
  Object.freeze({
    name: 'staff_users_specialist_id_idx',
    sql: 'CREATE UNIQUE INDEX staff_users_specialist_id_idx ON staff_users(specialist_id) WHERE specialist_id IS NOT NULL',
    columns: Object.freeze([
      Object.freeze({ cid: 7, name: 'specialist_id', seqno: 0 }),
    ]),
    partial: 1,
    table: 'staff_users',
    unique: 1,
  }),
])

const GENESIS_STATES = Object.freeze([
  Object.freeze({
    key: 'access.applied_generation',
    updated_at: '2026-07-30T00:00:00.000Z',
    value_json: `{"fingerprint":"${EMPTY_FINGERPRINT}","generation":0}`,
    version: 1,
  }),
  Object.freeze({
    key: 'access.desired_generation',
    updated_at: '2026-07-30T00:00:00.000Z',
    value_json: '{"generation":0}',
    version: 1,
  }),
  Object.freeze({
    key: 'access.reconcile.lease',
    updated_at: '2026-07-30T00:00:00.000Z',
    value_json: '{"expiresAt":null,"nonce":null,"owner":null}',
    version: 1,
  }),
])
const OUTBOX_DRAIN_HEARTBEAT_KEY = 'outbox.drain.last_success'
const CORE_DIRECTORY_UPGRADE = Object.freeze({
  key: 'core_directory_specialist_backfill_v1',
  value_json: '{"afterStaffId":null,"createdCount":0,"processedCount":0,"status":"pending"}',
  version: 1,
})
const SYSTEM_STATE_COUNT = GENESIS_STATES.length + 2

const OTHER_EMPTY_TABLES = Object.freeze([
  'backup_runs',
  'client_assignments',
  'clients',
  'delivery_attempts',
  'idempotency_records',
  'operational_actions',
  'scheduler_runs',
  'specialists',
])
const AUDIT_SCHEMAS = Object.freeze({
  'identity.activation': Object.freeze({ entityType: 'staff_user', metadata: { invitationVersion: 'version', specialistVersion: 'nullableVersion', staffVersion: 'version' }, legacyMetadata: { invitationVersion: 'version', staffVersion: 'version' } }),
  'staff.bootstrap': Object.freeze({ entityType: 'staff_user', metadata: { desiredGeneration: 'version', invitationVersion: 'version', specialistVersion: 'nullableVersion', staffVersion: 'version' }, legacyMetadata: { desiredGeneration: 'version', invitationVersion: 'version', staffVersion: 'version' } }),
  'staff.deactivated': Object.freeze({ entityType: 'staff_user', metadata: { desiredGeneration: 'version', specialistVersion: 'nullableVersion', staffVersion: 'version' }, legacyMetadata: { desiredGeneration: 'version', staffVersion: 'version' } }),
  'staff.invitation.expired': Object.freeze({ entityType: 'staff_invitation', metadata: { desiredGeneration: 'version', invitationVersion: 'version', specialistVersion: 'nullableVersion', staffVersion: 'version' }, legacyMetadata: { desiredGeneration: 'version', invitationVersion: 'version', staffVersion: 'version' } }),
  'staff.invited': Object.freeze({ entityType: 'staff_invitation', metadata: { desiredGeneration: 'version', invitationVersion: 'version', specialistVersion: 'nullableVersion', staffVersion: 'version' }, legacyMetadata: { desiredGeneration: 'version', invitationVersion: 'version', staffVersion: 'version' } }),
  'specialist.backfilled': Object.freeze({ entityType: 'specialist', metadata: { specialistVersion: 'version', stateVersion: 'version' }, system: true }),
  'core_directory.upgrade.advanced': Object.freeze({ entityType: 'system_state', metadata: { createdCount: 'count', processedCount: 'count', stateVersion: 'version' }, system: true }),
})

const ownObject = (value) => value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype
const exactKeys = (value, keys) => ownObject(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))
const validInstant = (value) => {
  try {
    return typeof value === 'string'
      && INSTANT.test(value)
      && new Date(value).toISOString() === value
  } catch {
    return false
  }
}
const iso = (nowMs) => {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('BOOTSTRAP_BUILD_INVALID')
  try {
    return new Date(nowMs).toISOString()
  } catch {
    throw new Error('BOOTSTRAP_BUILD_INVALID')
  }
}
const idFrom = (factory, prefix) => {
  const suffix = factory?.()
  const value = `${prefix}_${suffix}`
  if (typeof suffix !== 'string' || !ID.test(suffix) || !ID.test(value)) {
    throw new Error('BOOTSTRAP_BUILD_INVALID')
  }
  return value
}
const statement = (sql, params = []) => Object.freeze({
  params: Object.freeze([...params]),
  sql: sql.trim(),
})
const encrypted = async (cryptoContext, recordId, field, plaintext) => JSON.stringify(
  await encryptForScope(
    cryptoContext.keyring,
    cryptoContext.dataKey,
    {
      expectedScope: cryptoContext.scope,
      field,
      plaintext,
      recordId,
    },
  ),
)

const sameRow = (actual, expected) => ownObject(actual)
  && ownObject(expected)
  && Object.keys(actual).length === Object.keys(expected).length
  && Object.entries(expected).every(([key, value]) => Object.is(actual[key], value))

const canonicalSchemaSql = (value) => typeof value === 'string'
  ? value.trim().replace(/;\s*$/, '').replace(/\s+/g, ' ')
  : null

const canonicalIndexSql = (value) => canonicalSchemaSql(value)
  ?.replace(/\s*([(),])\s*/g, '$1')

const indexMatches = (definition, schemaResult, listResult, infoResult) => {
  const schemaRows = schemaResult?.results
  const indexRows = listResult?.results
  const columns = infoResult?.results
  return Array.isArray(schemaRows)
    && schemaRows.length === 1
    && exactKeys(schemaRows[0], ['name', 'type', 'sql'])
    && schemaRows[0].name === definition.name
    && schemaRows[0].type === 'index'
    && canonicalIndexSql(schemaRows[0].sql) === canonicalIndexSql(definition.sql)
    && Array.isArray(indexRows)
    && indexRows.length === 1
    && sameRow(indexRows[0], {
      name: definition.name,
      origin: 'c',
      partial: definition.partial,
      unique: definition.unique,
    })
    && Array.isArray(columns)
    && columns.length === definition.columns.length
    && columns.every((column, index) => (
      exactKeys(column, ['seqno', 'cid', 'name'])
      && sameRow(column, definition.columns[index])
    ))
}

const schemaSqlHash = async (value) => {
  const canonical = canonicalSchemaSql(value)
  if (!canonical) return null
  const bytes = new TextEncoder().encode(canonical)
  let digest
  try {
    digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  } finally {
    bytes.fill(0)
    digest?.fill(0)
  }
}

const validAccessStateShape = (rows) => {
  if (!Array.isArray(rows) || rows.length !== SYSTEM_STATE_COUNT) return false
  try {
    const [applied, desired, lease, upgrade, heartbeat] = rows
    if (![applied, desired, lease, upgrade, heartbeat].every((row) => (
      exactKeys(row, ['key', 'value_json', 'version', 'updated_at'])
      && Number.isSafeInteger(row.version)
      && row.version >= 1
      && validInstant(row.updated_at)
    ))
      || applied.key !== 'access.applied_generation'
      || desired.key !== 'access.desired_generation'
      || lease.key !== 'access.reconcile.lease'
      || upgrade.key !== CORE_DIRECTORY_UPGRADE.key
      || heartbeat.key !== OUTBOX_DRAIN_HEARTBEAT_KEY) return false
    const appliedValue = JSON.parse(applied.value_json)
    const desiredValue = JSON.parse(desired.value_json)
    const leaseValue = JSON.parse(lease.value_json)
    const upgradeValue = JSON.parse(upgrade.value_json)
    const heartbeatValue = JSON.parse(heartbeat.value_json)
    return exactKeys(appliedValue, ['fingerprint', 'generation'])
      && /^[A-Za-z0-9_-]{43}$/.test(appliedValue.fingerprint ?? '')
      && Number.isSafeInteger(appliedValue.generation)
      && appliedValue.generation >= 0
      && exactKeys(desiredValue, ['generation'])
      && Number.isSafeInteger(desiredValue.generation)
      && desiredValue.generation >= 0
      && exactKeys(leaseValue, ['expiresAt', 'nonce', 'owner'])
      && (leaseValue.expiresAt === null || validInstant(leaseValue.expiresAt))
      && (leaseValue.nonce === null || ID.test(leaseValue.nonce))
      && (leaseValue.owner === null || ID.test(leaseValue.owner))
      && sameRow(upgrade, {
        ...CORE_DIRECTORY_UPGRADE,
        updated_at: upgrade.updated_at,
      })
      && exactKeys(upgradeValue, ['afterStaffId', 'createdCount', 'processedCount', 'status'])
      && upgradeValue.afterStaffId === null
      && upgradeValue.createdCount === 0
      && upgradeValue.processedCount === 0
      && upgradeValue.status === 'pending'
      && exactKeys(heartbeatValue, ['completedAt'])
      && JSON.stringify(heartbeatValue) === heartbeat.value_json
      && (heartbeatValue.completedAt === null || (
        validInstant(heartbeatValue.completedAt)
        && heartbeatValue.completedAt <= heartbeat.updated_at
      ))
      && (heartbeat.version !== 1 || heartbeatValue.completedAt === null)
  } catch {
    return false
  }
}

const snapshotMatches = async (keyring, dataKey, scope, version, row) => {
  try {
    const plaintext = await decryptForScope(keyring, dataKey, {
      expectedScope: scope,
      field: 'record_version',
      envelope: JSON.parse(version.snapshot_envelope),
      recordId: row.id,
    })
    return sameRow(JSON.parse(plaintext), row)
  } catch {
    return false
  }
}

export async function inspectBootstrapSchema(db) {
  if (!db?.prepare) return Object.freeze({ kind: 'refused' })
  try {
    const [
      migrationResult,
      schemaResult,
      columnResult,
      stateResult,
      staffCount,
      ...requiredIndexResults
    ] = await Promise.all([
      db.prepare('SELECT name FROM d1_migrations ORDER BY id').all(),
      db.prepare(
        `SELECT name,type,sql
         FROM sqlite_schema
         WHERE type IN ('table','trigger','view')
           AND name NOT LIKE 'sqlite_%'
           AND name NOT LIKE '_cf_%'
         ORDER BY type,name`
      ).all(),
      db.prepare(
        `SELECT m.name AS table_name,p.name AS column_name,p.cid
         FROM sqlite_schema AS m
         JOIN pragma_table_info(m.name) AS p
         WHERE m.type='table' AND m.name NOT LIKE 'sqlite_%'
           AND m.name NOT LIKE '_cf_%'
           AND m.name!='d1_migrations'
         ORDER BY m.name,p.cid`
      ).all(),
      db.prepare(
        'SELECT key,value_json,version,updated_at FROM system_state ORDER BY key'
      ).all(),
      db.prepare('SELECT count(*) AS count FROM staff_users').first(),
      ...REQUIRED_INDEXES.flatMap(({ name, table }) => [
        db.prepare(
          `SELECT name,type,sql
           FROM sqlite_schema
           WHERE type='index' AND name='${name}'`
        ).all(),
        db.prepare(
          `SELECT name,"unique",origin,partial
           FROM pragma_index_list('${table}')
           WHERE name='${name}'`
        ).all(),
        db.prepare(
          `SELECT seqno,cid,name
           FROM pragma_index_info('${name}')
           ORDER BY seqno`
        ).all(),
      ]),
    ])
    const migrations = migrationResult?.results
    const schema = schemaResult?.results
    const columns = columnResult?.results
    if (!Array.isArray(migrations)
      || migrations.length !== MIGRATIONS.length
      || migrations.some((row, index) => !exactKeys(row, ['name'])
        || row.name !== MIGRATIONS[index])
      || !Array.isArray(schema)
      || !Array.isArray(columns)) return Object.freeze({ kind: 'refused' })

    const tableRows = schema.filter(({ type }) => type === 'table')
    const triggerRows = schema.filter(({ type }) => type === 'trigger')
    const viewRows = schema.filter(({ type }) => type === 'view')
    const expectedTables = ['d1_migrations', ...Object.keys(TABLE_COLUMNS)].sort()
    if (tableRows.length !== expectedTables.length
      || tableRows.some((row, index) => !exactKeys(row, ['name', 'type', 'sql'])
        || row.type !== 'table'
        || row.name !== expectedTables[index]
        || typeof row.sql !== 'string'
        || row.sql.length < 1)
      || triggerRows.length !== REQUIRED_TRIGGERS.length
      || triggerRows.some((row, index) => !exactKeys(row, ['name', 'type', 'sql'])
        || row.type !== 'trigger'
        || row.name !== REQUIRED_TRIGGERS[index]
        || typeof row.sql !== 'string'
        || row.sql.length < 1)
      || viewRows.length !== Object.keys(REQUIRED_VIEWS).length
      || viewRows.some((row) => !exactKeys(row, ['name', 'type', 'sql'])
        || row.type !== 'view'
        || canonicalSchemaSql(row.sql) !== REQUIRED_VIEWS[row.name])) {
      return Object.freeze({ kind: 'refused' })
    }
    const triggerHashes = await Promise.all(triggerRows.map(({ sql }) => schemaSqlHash(sql)))
    if (triggerRows.some((row, index) => (
      triggerHashes[index] !== TRIGGER_HASHES[row.name]
    ))) return Object.freeze({ kind: 'refused' })
    const applicationTables = tableRows.filter(({ name }) => name !== 'd1_migrations')
    const tableHashes = await Promise.all(applicationTables.map(({ sql }) => schemaSqlHash(sql)))
    if (applicationTables.some((row, index) => (
      tableHashes[index] !== TABLE_HASHES[row.name]
    ))) return Object.freeze({ kind: 'refused' })

    if (requiredIndexResults.length !== REQUIRED_INDEXES.length * 3
      || REQUIRED_INDEXES.some((definition, index) => !indexMatches(
        definition,
        requiredIndexResults[index * 3],
        requiredIndexResults[index * 3 + 1],
        requiredIndexResults[index * 3 + 2],
      ))) return Object.freeze({ kind: 'refused' })

    const expectedColumns = Object.entries(TABLE_COLUMNS)
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([tableName, names]) => names.map((columnName, cid) => ({
        cid,
        column_name: columnName,
        table_name: tableName,
      })))
    if (columns.length !== expectedColumns.length
      || columns.some((row, index) => !exactKeys(row, ['table_name', 'column_name', 'cid'])
        || !sameRow(row, expectedColumns[index]))) return Object.freeze({ kind: 'refused' })
    const states = stateResult?.results
    if (!validAccessStateShape(states)
      || !exactKeys(staffCount, ['count'])
      || !Number.isSafeInteger(staffCount.count)
      || staffCount.count < 0
      || (staffCount.count === 0
        && !states.slice(0, GENESIS_STATES.length).every(
          (row, index) => sameRow(row, GENESIS_STATES[index]),
        ))) {
      return Object.freeze({ kind: 'refused' })
    }
    return Object.freeze({ kind: 'ready' })
  } catch {
    return Object.freeze({ kind: 'refused' })
  }
}

export async function buildBootstrapCreationBatch(input = {}) {
  if (!ownObject(input)
    || !input.keyring
    || !exactKeys(input.scope, ['id', 'purpose', 'type'])
    || input.scope.id !== 'centre_1'
    || input.scope.purpose !== 'identity'
    || input.scope.type !== 'staff_directory'
    || typeof input.ownerEmail !== 'string'
    || !/^[^@\s]+@example\.test$/.test(input.ownerEmail)
    || typeof input.ownerDisplayName !== 'string'
    || input.ownerDisplayName.length < 1
    || typeof input.idFactory !== 'function'
    || !ID.test(input.correlationId ?? '')
    || !exactKeys(input.keyringConfig, [
      'activeBackupKekVersion',
      'activeDataKekVersion',
      'activeLookupKeyVersion',
    ])
    || Object.values(input.keyringConfig).some((value) => value !== 1)) {
    throw new Error('BOOTSTRAP_BUILD_INVALID')
  }
  const now = iso(input.nowMs)
  const expiresAt = iso(input.nowMs + (7 * DAY_MS))
  const ids = Object.freeze({
    auditId: idFrom(input.idFactory, 'aud'),
    dataKeyId: idFrom(input.idFactory, 'key'),
    expiryJobId: idFrom(input.idFactory, 'job'),
    invitationId: idFrom(input.idFactory, 'inv'),
    invitationVersionId: idFrom(input.idFactory, 'ver'),
    reconcileJobId: idFrom(input.idFactory, 'job'),
    staffId: idFrom(input.idFactory, 'stf'),
    staffVersionId: idFrom(input.idFactory, 'ver'),
  })
  const dataKey = await createWrappedDataKey(input.keyring, {
    createdAt: now,
    dekVersion: 1,
    id: ids.dataKeyId,
    scope: input.scope,
  })
  const cryptoContext = {
    dataKey,
    keyring: input.keyring,
    scope: input.scope,
  }
  const emailLookup = await blindEmailIndex(input.ownerEmail, input.keyring, 1)
  const staff = {
    access_subject: null,
    activated_at: null,
    created_at: now,
    disabled_at: null,
    display_name_envelope: await encrypted(
      cryptoContext,
      ids.staffId,
      'display_name',
      input.ownerDisplayName,
    ),
    email_envelope: await encrypted(
      cryptoContext,
      ids.staffId,
      'email',
      input.ownerEmail,
    ),
    email_lookup: emailLookup,
    id: ids.staffId,
    role: 'owner',
    specialist_id: null,
    status: 'pending',
    updated_at: now,
    version: 1,
  }
  const invitation = {
    access_allowed_at: null,
    activated_at: null,
    created_at: now,
    display_name_envelope: await encrypted(
      cryptoContext,
      ids.invitationId,
      'display_name',
      input.ownerDisplayName,
    ),
    email_envelope: await encrypted(
      cryptoContext,
      ids.invitationId,
      'email',
      input.ownerEmail,
    ),
    email_lookup: emailLookup,
    email_sent_at: null,
    expires_at: expiresAt,
    id: ids.invitationId,
    inviter_id: ids.staffId,
    revoked_at: null,
    role: 'owner',
    staff_id: ids.staffId,
    status: 'provisioning',
    updated_at: now,
    version: 1,
  }
  const staffSnapshot = await encrypted(
    cryptoContext,
    ids.staffId,
    'record_version',
    JSON.stringify(staff),
  )
  const invitationSnapshot = await encrypted(
    cryptoContext,
    ids.invitationId,
    'record_version',
    JSON.stringify(invitation),
  )
  const reconcilePayload = await encrypted(
    cryptoContext,
    ids.reconcileJobId,
    'job_payload',
    JSON.stringify({ actorId: ids.staffId, generation: 1 }),
  )
  const expiryPayload = await encrypted(
    cryptoContext,
    ids.expiryJobId,
    'job_payload',
    JSON.stringify({ actorId: ids.staffId, invitationId: ids.invitationId }),
  )
  const metadata = JSON.stringify({
    desiredGeneration: 1,
    invitationVersion: 1,
    specialistVersion: null,
    staffVersion: 1,
  })
  const proof = Object.freeze({
    audit_id: ids.auditId,
    data_key_id: ids.dataKeyId,
    expiry_job_id: ids.expiryJobId,
    invitation_id: ids.invitationId,
    invitation_version_id: ids.invitationVersionId,
    reconcile_job_id: ids.reconcileJobId,
    staff_id: ids.staffId,
    staff_version_id: ids.staffVersionId,
    state: 'pre-reconcile',
  })
  const reconcileKey = 'staff.access.reconcile:1'
  const expiryKey = `staff.invitation.expire:${ids.invitationId}`
  const batch = [
    statement(
      `INSERT INTO data_keys
       (id,scope_type,scope_id,purpose,dek_version,wrapped_key_b64,wrap_nonce_b64,
        kek_version,created_at,retired_at)
       SELECT ?,?,?,?,1,?,?,1,?,NULL
       WHERE NOT EXISTS (SELECT 1 FROM staff_users)
         AND NOT EXISTS (SELECT 1 FROM data_keys)`,
      [
        dataKey.id,
        dataKey.scope_type,
        dataKey.scope_id,
        dataKey.purpose,
        dataKey.wrapped_key_b64,
        dataKey.wrap_nonce_b64,
        dataKey.created_at,
      ],
    ),
    statement(
      `INSERT INTO staff_users
       (id,email_lookup,email_envelope,display_name_envelope,role,status,
        access_subject,specialist_id,version,activated_at,disabled_at,created_at,updated_at)
       SELECT ?,?,?,?,'owner','pending',NULL,NULL,1,NULL,NULL,?,?
       WHERE NOT EXISTS (SELECT 1 FROM staff_users)`,
      [
        staff.id,
        staff.email_lookup,
        staff.email_envelope,
        staff.display_name_envelope,
        staff.created_at,
        staff.updated_at,
      ],
    ),
    statement(
      `INSERT INTO staff_invitations
       (id,staff_id,email_lookup,email_envelope,display_name_envelope,role,status,
        inviter_id,expires_at,access_allowed_at,email_sent_at,activated_at,revoked_at,
        version,created_at,updated_at)
       SELECT ?,?,?,?,?,'owner','provisioning',?,?,NULL,NULL,NULL,NULL,1,?,?
       WHERE EXISTS (
         SELECT 1 FROM staff_users
         WHERE id=? AND role='owner' AND status='pending' AND version=1
       )`,
      [
        invitation.id,
        invitation.staff_id,
        invitation.email_lookup,
        invitation.email_envelope,
        invitation.display_name_envelope,
        invitation.inviter_id,
        invitation.expires_at,
        invitation.created_at,
        invitation.updated_at,
        staff.id,
      ],
    ),
    statement(
      `INSERT INTO record_versions
       (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
        changed_at,correlation_id)
       SELECT ?,'staff_user',?,1,?,NULL,?,?
       WHERE EXISTS (SELECT 1 FROM staff_users WHERE id=? AND version=1)`,
      [
        ids.staffVersionId,
        staff.id,
        staffSnapshot,
        now,
        input.correlationId,
        staff.id,
      ],
    ),
    statement(
      `INSERT INTO record_versions
       (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
        changed_at,correlation_id)
       SELECT ?,'staff_invitation',?,1,?,NULL,?,?
       WHERE EXISTS (SELECT 1 FROM staff_invitations WHERE id=? AND version=1)`,
      [
        ids.invitationVersionId,
        invitation.id,
        invitationSnapshot,
        now,
        input.correlationId,
        invitation.id,
      ],
    ),
    statement(
      `INSERT INTO audit_events
       (id,occurred_at,actor_staff_id,action,entity_type,entity_id,result,
        reason_envelope,correlation_id,metadata_json)
       SELECT ?,?,NULL,'staff.bootstrap','staff_user',?,'success',NULL,?,?
       WHERE EXISTS (SELECT 1 FROM staff_users WHERE id=? AND version=1)`,
      [
        ids.auditId,
        now,
        staff.id,
        input.correlationId,
        metadata,
        staff.id,
      ],
    ),
    statement(
      `UPDATE system_state
       SET value_json='{"generation":1}',version=version+1,updated_at=?
       WHERE key='access.desired_generation'
         AND value_json='{"generation":0}' AND version=1
         AND EXISTS (
           SELECT 1 FROM audit_events
           WHERE id=? AND action='staff.bootstrap'
         )`,
      [now, ids.auditId],
    ),
    statement(
      `INSERT INTO outbox_jobs
       (id,type,aggregate_type,aggregate_id,payload_envelope,idempotency_key,status,
        attempt_count,max_attempts,scheduled_at,lease_owner,lease_expires_at,
        last_error_code,created_at,updated_at)
       SELECT ?,'staff.access.reconcile','access_group','centre_1',?,?,'queued',
              0,8,?,NULL,NULL,NULL,?,?
       WHERE EXISTS (
         SELECT 1 FROM system_state
         WHERE key='access.desired_generation'
           AND value_json='{"generation":1}' AND version=2
       ) AND changes()=1`,
      [
        ids.reconcileJobId,
        reconcilePayload,
        reconcileKey,
        now,
        now,
        now,
      ],
    ),
    statement(
      `INSERT INTO outbox_jobs
       (id,type,aggregate_type,aggregate_id,payload_envelope,idempotency_key,status,
        attempt_count,max_attempts,scheduled_at,lease_owner,lease_expires_at,
        last_error_code,created_at,updated_at)
       SELECT ?,'staff.invitation.expire','staff_invitation',?,?,?,'queued',
              0,8,?,NULL,NULL,NULL,?,?
       WHERE EXISTS (
         SELECT 1 FROM staff_invitations
         WHERE id=? AND status='provisioning' AND version=1
       )`,
      [
        ids.expiryJobId,
        invitation.id,
        expiryPayload,
        expiryKey,
        expiresAt,
        now,
        now,
        invitation.id,
      ],
    ),
    statement(
      `INSERT INTO outbox_operation_guard_failures (operation_id)
       SELECT 'bootstrap_create_guard'
       WHERE NOT (
         (SELECT count(*) FROM data_keys)=1
         AND EXISTS (
           SELECT 1 FROM data_keys
           WHERE id=? AND scope_type='staff_directory' AND scope_id='centre_1'
             AND purpose='identity' AND dek_version=1 AND kek_version=1
             AND wrapped_key_b64=? AND wrap_nonce_b64=?
             AND created_at=? AND retired_at IS NULL
         )
         AND (SELECT count(*) FROM staff_users)=1
         AND EXISTS (
           SELECT 1 FROM staff_users
           WHERE id=? AND role='owner' AND status='pending' AND version=1
             AND email_lookup=? AND email_envelope=? AND display_name_envelope=?
             AND access_subject IS NULL AND specialist_id IS NULL
             AND activated_at IS NULL AND disabled_at IS NULL
             AND created_at=? AND updated_at=?
         )
         AND (SELECT count(*) FROM staff_invitations)=1
         AND EXISTS (
           SELECT 1 FROM staff_invitations
           WHERE id=? AND staff_id=? AND inviter_id=? AND role='owner'
             AND status='provisioning' AND version=1
             AND email_lookup=? AND email_envelope=? AND display_name_envelope=?
             AND expires_at=?
             AND access_allowed_at IS NULL AND email_sent_at IS NULL
             AND activated_at IS NULL AND revoked_at IS NULL
             AND created_at=? AND updated_at=?
         )
         AND (SELECT count(*) FROM record_versions)=2
         AND EXISTS (
           SELECT 1 FROM record_versions
           WHERE id=? AND entity_type='staff_user' AND entity_id=? AND version=1
             AND snapshot_envelope=? AND changed_by_staff_id IS NULL
             AND changed_at=? AND correlation_id=?
         )
         AND EXISTS (
           SELECT 1 FROM record_versions
           WHERE id=? AND entity_type='staff_invitation' AND entity_id=? AND version=1
             AND snapshot_envelope=? AND changed_by_staff_id IS NULL
             AND changed_at=? AND correlation_id=?
         )
         AND (SELECT count(*) FROM audit_events)=1
         AND EXISTS (
           SELECT 1 FROM audit_events
           WHERE id=? AND occurred_at=? AND actor_staff_id IS NULL
             AND action='staff.bootstrap'
             AND entity_type='staff_user' AND entity_id=? AND result='success'
             AND reason_envelope IS NULL AND correlation_id=? AND metadata_json=?
         )
         AND EXISTS (
           SELECT 1 FROM system_state
           WHERE key='access.desired_generation'
             AND value_json='{"generation":1}' AND version=2 AND updated_at=?
         )
         AND EXISTS (
           SELECT 1 FROM system_state
           WHERE key='access.applied_generation'
             AND value_json=? AND version=1
             AND updated_at='2026-07-30T00:00:00.000Z'
         )
         AND EXISTS (
           SELECT 1 FROM system_state
           WHERE key='access.reconcile.lease'
             AND value_json='{"expiresAt":null,"nonce":null,"owner":null}'
             AND version=1 AND updated_at='2026-07-30T00:00:00.000Z'
         )
         AND EXISTS (
           SELECT 1 FROM system_state
           WHERE key='core_directory_specialist_backfill_v1'
             AND value_json='{"afterStaffId":null,"createdCount":0,"processedCount":0,"status":"pending"}'
             AND version=1
             AND updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', julianday(updated_at))
         )
         AND EXISTS (
           SELECT 1 FROM system_state
           WHERE key='outbox.drain.last_success'
             AND typeof(version)='integer' AND version>=1
             AND (
               value_json='{"completedAt":null}'
               OR (
                 json_type(value_json,'$.completedAt')='text'
                 AND value_json='{"completedAt":'
                   || json_quote(json_extract(value_json,'$.completedAt')) || '}'
                 AND json_extract(value_json,'$.completedAt')<=updated_at
               )
             )
         )
         AND (SELECT count(*) FROM system_state)=5
         AND (SELECT count(*) FROM client_assignments)=0
         AND (SELECT count(*) FROM clients)=0
         AND (SELECT count(*) FROM specialists)=0
         AND (SELECT count(*) FROM outbox_jobs)=2
         AND EXISTS (
           SELECT 1 FROM outbox_jobs
           WHERE id=? AND type='staff.access.reconcile'
             AND aggregate_type='access_group' AND aggregate_id='centre_1'
             AND payload_envelope=? AND idempotency_key=?
             AND status='queued' AND attempt_count=0 AND max_attempts=8
             AND scheduled_at=? AND lease_owner IS NULL
             AND lease_expires_at IS NULL AND last_error_code IS NULL
             AND created_at=? AND updated_at=?
         )
         AND EXISTS (
           SELECT 1 FROM outbox_jobs
           WHERE id=? AND type='staff.invitation.expire'
             AND aggregate_type='staff_invitation' AND aggregate_id=?
             AND payload_envelope=? AND idempotency_key=?
             AND status='queued' AND attempt_count=0 AND max_attempts=8
             AND scheduled_at=? AND lease_owner IS NULL
             AND lease_expires_at IS NULL AND last_error_code IS NULL
             AND created_at=? AND updated_at=?
         )
         AND (SELECT count(*) FROM outbox_attempts)=0
         AND (SELECT count(*) FROM delivery_attempts)=0
         AND (SELECT count(*) FROM idempotency_records)=0
         AND (SELECT count(*) FROM operational_actions)=0
         AND (SELECT count(*) FROM scheduler_runs)=0
         AND (SELECT count(*) FROM backup_runs)=0
       )`,
      [
        dataKey.id,
        dataKey.wrapped_key_b64,
        dataKey.wrap_nonce_b64,
        dataKey.created_at,
        staff.id,
        staff.email_lookup,
        staff.email_envelope,
        staff.display_name_envelope,
        staff.created_at,
        staff.updated_at,
        invitation.id,
        staff.id,
        staff.id,
        invitation.email_lookup,
        invitation.email_envelope,
        invitation.display_name_envelope,
        invitation.expires_at,
        invitation.created_at,
        invitation.updated_at,
        ids.staffVersionId,
        staff.id,
        staffSnapshot,
        now,
        input.correlationId,
        ids.invitationVersionId,
        invitation.id,
        invitationSnapshot,
        now,
        input.correlationId,
        ids.auditId,
        now,
        staff.id,
        input.correlationId,
        metadata,
        now,
        JSON.stringify({
          fingerprint: EMPTY_FINGERPRINT,
          generation: 0,
        }),
        ids.reconcileJobId,
        reconcilePayload,
        reconcileKey,
        now,
        now,
        now,
        ids.expiryJobId,
        invitation.id,
        expiryPayload,
        expiryKey,
        expiresAt,
        now,
        now,
      ],
    ),
    statement(
      `SELECT
         ? AS audit_id,
         ? AS data_key_id,
         ? AS expiry_job_id,
         ? AS invitation_id,
         ? AS invitation_version_id,
         ? AS reconcile_job_id,
         ? AS staff_id,
         ? AS staff_version_id,
         ? AS state`,
      Object.values(proof),
    ),
  ]
  if (batch.some(({ params }) => params.some((value) => typeof value !== 'string'))) {
    throw new Error('BOOTSTRAP_BUILD_INVALID')
  }
  return Object.freeze({
    batch: Object.freeze(batch),
    ids,
    proof,
  })
}

const aggregateRefused = () => {
  throw new Error('BOOTSTRAP_STATE_REFUSED')
}

const canonicalValue = (value) => {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!ownObject(value)) return value
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, canonicalValue(child)]))
}
const canonicalJson = (value) => JSON.stringify(canonicalValue(value))

export function normalizeBootstrapAuditEvent(row) {
  if (!exactKeys(row, TABLE_COLUMNS.audit_events)) aggregateRefused()
  const schema = AUDIT_SCHEMAS[row.action]
  if (!schema
    || !ID.test(row.id ?? '')
    || !validInstant(row.occurred_at)
    || (row.actor_staff_id !== null && !STAFF_ID.test(row.actor_staff_id ?? ''))
    || (schema.system && row.actor_staff_id !== null)
    || row.entity_type !== schema.entityType
    || !ID.test(row.entity_id ?? '')
    || row.result !== 'success'
    || row.reason_envelope !== null
    || !ID.test(row.correlation_id ?? '')
    || typeof row.metadata_json !== 'string') aggregateRefused()
  if (row.action === 'specialist.backfilled'
    && !SPECIALIST_ID.test(row.entity_id)) aggregateRefused()
  if (row.action === 'core_directory.upgrade.advanced'
    && row.entity_id !== CORE_DIRECTORY_UPGRADE.key) aggregateRefused()

  let parsed
  try {
    parsed = JSON.parse(row.metadata_json)
  } catch {
    aggregateRefused()
  }
  if (!ownObject(parsed) || canonicalJson(parsed) !== row.metadata_json) aggregateRefused()
  const metadataKeys = Object.keys(schema.metadata)
  const legacyKeys = Object.keys(schema.legacyMetadata ?? {})
  const exact = exactKeys(parsed, metadataKeys)
  const legacy = !exact && schema.legacyMetadata && exactKeys(parsed, legacyKeys)
  if (!exact && !legacy) aggregateRefused()
  const types = legacy ? schema.legacyMetadata : schema.metadata
  for (const [key, type] of Object.entries(types)) {
    const value = parsed[key]
    if ((type === 'version' && (!Number.isSafeInteger(value) || value < 1))
      || (type === 'nullableVersion' && value !== null
        && (!Number.isSafeInteger(value) || value < 1))
      || (type === 'count' && (!Number.isSafeInteger(value) || value < 0))) {
      aggregateRefused()
    }
  }
  const metadata = legacy
    ? Object.freeze({ ...parsed, specialistVersion: null })
    : Object.freeze({ ...parsed })
  return Object.freeze({ ...row, metadata })
}

const exactReleasedLease = (row) => exactKeys(
  row,
  TABLE_COLUMNS.system_state,
) && row.key === 'access.reconcile.lease'
  && row.value_json === '{"expiresAt":null,"nonce":null,"owner":null}'
  && Number.isSafeInteger(row.version)
  && row.version >= 1
  && validInstant(row.updated_at)

const validateJobBase = (row, createdAt) => {
  if (!exactKeys(row, TABLE_COLUMNS.outbox_jobs)
    || !ID.test(row.id ?? '')
    || !validInstant(row.created_at)
    || !validInstant(row.updated_at)
    || row.created_at !== createdAt
    || row.updated_at < row.created_at
    || row.max_attempts !== 8) aggregateRefused()
}

const completedRetryDue = (attempt, job, number, notBefore, now) => {
  if (!exactKeys(attempt, TABLE_COLUMNS.outbox_attempts)
    || !ID.test(attempt.id ?? '')
    || attempt.job_id !== job.id
    || attempt.attempt_number !== number
    || !validInstant(attempt.started_at)
    || !validInstant(attempt.completed_at)
    || attempt.started_at < notBefore
    || attempt.completed_at < attempt.started_at
    || attempt.completed_at > now
    || attempt.result !== 'retry'
    || !['OUTBOX_HANDLER_RETRY', 'OUTBOX_LEASE_EXPIRED'].includes(attempt.error_code)
    || attempt.provider_reference !== null) aggregateRefused()
  const leaseExpiryMs = Date.parse(attempt.started_at) + OUTBOX_LEASE_MS
  if ((attempt.error_code === 'OUTBOX_HANDLER_RETRY'
      && Date.parse(attempt.completed_at) >= leaseExpiryMs)
    || (attempt.error_code === 'OUTBOX_LEASE_EXPIRED'
      && Date.parse(attempt.completed_at) < leaseExpiryMs)) aggregateRefused()
  if (attempt.error_code === 'OUTBOX_LEASE_EXPIRED') return attempt.completed_at
  const delay = retryDelayMs(number)
  if (delay === null) aggregateRefused()
  return iso(Date.parse(attempt.completed_at) + delay)
}

const inspectReconcileHistory = (job, attempts, now) => {
  if (!Array.isArray(attempts)
    || job.attempt_count !== attempts.length
    || !Number.isSafeInteger(job.attempt_count)
    || job.attempt_count < 0
    || job.attempt_count > 8
    || new Set(attempts.map(({ id }) => id)).size !== attempts.length) {
    aggregateRefused()
  }
  let notBefore = job.created_at
  const completedRetryCount = job.status === 'processing'
    ? job.attempt_count - 1
    : job.status === 'succeeded'
      ? job.attempt_count - 1
      : job.attempt_count
  if (!['queued', 'processing', 'succeeded'].includes(job.status)
    || completedRetryCount < 0
    || completedRetryCount > 7) aggregateRefused()
  for (let index = 0; index < completedRetryCount; index += 1) {
    notBefore = completedRetryDue(attempts[index], job, index + 1, notBefore, now)
  }

  if (job.status === 'queued') {
    if (job.attempt_count > 7
      || job.lease_owner !== null
      || job.lease_expires_at !== null) aggregateRefused()
    if (job.attempt_count === 0) {
      if (job.scheduled_at !== job.created_at
        || job.updated_at !== job.created_at
        || job.last_error_code !== null) aggregateRefused()
      return Object.freeze({
        kind: 'queued-initial',
        mandatoryAccessIndexes: Object.freeze([]),
        possibleAccessIndexes: Object.freeze([]),
      })
    }
    const last = attempts.at(-1)
    if (job.scheduled_at !== notBefore
      || job.updated_at !== last.completed_at
      || job.last_error_code !== last.error_code) aggregateRefused()
    return Object.freeze({
      kind: 'queued-retry',
      mandatoryAccessIndexes: Object.freeze(attempts.flatMap(
        ({ error_code }, index) => error_code === 'OUTBOX_HANDLER_RETRY'
          ? [index]
          : [],
      )),
      possibleAccessIndexes: Object.freeze(attempts.map((_, index) => index)),
    })
  }

  if (job.status === 'processing') {
    if (job.attempt_count < 1
      || job.attempt_count > 7
      || !ID.test(job.lease_owner ?? '')
      || !validInstant(job.lease_expires_at)
      || job.lease_expires_at > now) aggregateRefused()
    const open = attempts.at(-1)
    if (!exactKeys(open, TABLE_COLUMNS.outbox_attempts)
      || !ID.test(open.id ?? '')
      || open.job_id !== job.id
      || open.attempt_number !== job.attempt_count
      || !validInstant(open.started_at)
      || open.started_at < notBefore
      || open.started_at > now
      || open.completed_at !== null
      || open.result !== null
      || open.error_code !== null
      || open.provider_reference !== null
      || job.scheduled_at !== notBefore
      || job.updated_at !== open.started_at
      || job.lease_expires_at !== iso(Date.parse(open.started_at) + OUTBOX_LEASE_MS)
      || job.last_error_code !== (completedRetryCount === 0
        ? null
        : attempts[completedRetryCount - 1].error_code)) aggregateRefused()
    return Object.freeze({
      kind: 'processing-expired',
      mandatoryAccessIndexes: Object.freeze(attempts.slice(0, -1).flatMap(
        ({ error_code }, index) => error_code === 'OUTBOX_HANDLER_RETRY'
          ? [index]
          : [],
      )),
      possibleAccessIndexes: Object.freeze(attempts.map((_, index) => index)),
    })
  }

  if (job.attempt_count < 1
    || job.lease_owner !== null
    || job.lease_expires_at !== null
    || job.last_error_code !== null) aggregateRefused()
  const succeeded = attempts.at(-1)
  if (!exactKeys(succeeded, TABLE_COLUMNS.outbox_attempts)
    || !ID.test(succeeded.id ?? '')
    || succeeded.job_id !== job.id
    || succeeded.attempt_number !== job.attempt_count
    || !validInstant(succeeded.started_at)
    || !validInstant(succeeded.completed_at)
    || succeeded.started_at < notBefore
    || succeeded.completed_at < succeeded.started_at
    || succeeded.completed_at >= iso(Date.parse(succeeded.started_at) + OUTBOX_LEASE_MS)
    || succeeded.completed_at > now
    || succeeded.result !== 'succeeded'
    || succeeded.error_code !== null
    || succeeded.provider_reference !== null
    || job.scheduled_at !== notBefore
    || job.updated_at !== succeeded.completed_at) aggregateRefused()
  return Object.freeze({
    kind: 'succeeded',
    mandatoryAccessIndexes: Object.freeze([
      ...attempts.slice(0, -1).flatMap(
        ({ error_code }, index) => error_code === 'OUTBOX_HANDLER_RETRY'
          ? [index]
          : [],
      ),
      attempts.length - 1,
    ]),
    possibleAccessIndexes: Object.freeze(attempts.map((_, index) => index)),
  })
}

const instantFallsWithinAttempt = (value, attempt, now) => {
  const end = attempt.completed_at
    ?? iso(Math.min(Date.parse(now), Date.parse(attempt.started_at) + OUTBOX_LEASE_MS))
  return attempt.started_at <= value && value <= end
}

const leaseTimestampMatchesHistory = ({
  attempts,
  leaseRuns,
  mandatoryIndexes,
  now,
  possibleIndexes,
  updatedAt,
}) => {
  const mandatory = new Set(mandatoryIndexes)
  const optional = possibleIndexes.filter((index) => !mandatory.has(index))
  if (leaseRuns < mandatory.size || leaseRuns > mandatory.size + optional.length) {
    return false
  }
  for (let mask = 0; mask < 2 ** optional.length; mask += 1) {
    const selected = [...mandatory]
    for (let index = 0; index < optional.length; index += 1) {
      if ((mask & (2 ** index)) !== 0) selected.push(optional[index])
    }
    if (selected.length !== leaseRuns) continue
    const latest = Math.max(...selected)
    if (instantFallsWithinAttempt(updatedAt, attempts[latest], now)) return true
  }
  return false
}

const snapshotRows = async (db) => {
  const selections = [
    ['data_keys', 'id'],
    ['staff_users', 'id'],
    ['staff_invitations', 'id'],
    ['record_versions', 'entity_type,entity_id,version,id'],
    ['audit_events', 'occurred_at,id'],
    ['outbox_jobs', 'created_at,id'],
    ['outbox_attempts', 'job_id,attempt_number,id'],
    ['system_state', 'key'],
    ...OTHER_EMPTY_TABLES.map((table) => [table, 'rowid']),
  ]
  const results = await db.batch(selections.map(([table, order]) => (
    db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`)
  )))
  if (!Array.isArray(results) || results.length !== selections.length
    || results.some((result) => !Array.isArray(result?.results))) aggregateRefused()
  return results.map(({ results: rows }) => rows)
}

const inspectBootstrapAggregateFromSnapshot = async ({
  db,
  keyring,
  nowMs,
  ownerDisplayName,
  ownerEmail,
} = {}, capturedRows = null) => {
  if (!db?.prepare || !db?.batch || !keyring || !Number.isSafeInteger(nowMs)
    || typeof ownerDisplayName !== 'string' || typeof ownerEmail !== 'string') {
    return Object.freeze({ kind: 'refused' })
  }
  try {
    const [
      dataKeys,
      staffRows,
      invitations,
      versions,
      audits,
      jobs,
      attempts,
      states,
      ...emptyTables
    ] = capturedRows ?? await snapshotRows(db)
    if (emptyTables.some((rows) => rows.length !== 0)
      || dataKeys.length !== 1
      || staffRows.length !== 1
      || invitations.length !== 1
      || !validAccessStateShape(states)) return Object.freeze({ kind: 'refused' })
    const dataKey = dataKeys[0]
    const staff = staffRows[0]
    const invitation = invitations[0]
    const now = iso(nowMs)
    const published = invitation.status === 'pending' && invitation.version === 2
    const preReconcile = invitation.status === 'provisioning' && invitation.version === 1
    if (!exactKeys(dataKey, TABLE_COLUMNS.data_keys)
      || !exactKeys(staff, TABLE_COLUMNS.staff_users)
      || !exactKeys(invitation, TABLE_COLUMNS.staff_invitations)
      || !ID.test(dataKey.id ?? '')
      || !STAFF_ID.test(staff.id ?? '')
      || !INVITATION_ID.test(invitation.id ?? '')
      || invitation.staff_id !== staff.id
      || invitation.inviter_id !== staff.id
      || staff.role !== 'owner'
      || staff.status !== 'pending'
      || staff.version !== 1
      || staff.access_subject !== null
      || staff.specialist_id !== null
      || staff.activated_at !== null
      || staff.disabled_at !== null
      || invitation.role !== 'owner'
      || (!preReconcile && !published)
      || (preReconcile && invitation.access_allowed_at !== null)
      || (published && !validInstant(invitation.access_allowed_at))
      || invitation.email_sent_at !== null
      || invitation.activated_at !== null
      || invitation.revoked_at !== null
      || !validInstant(staff.created_at)
      || staff.created_at > now
      || staff.updated_at !== staff.created_at
      || invitation.created_at !== staff.created_at
      || (preReconcile && invitation.updated_at !== staff.created_at)
      || (published && invitation.updated_at !== invitation.access_allowed_at)
      || !validInstant(invitation.expires_at)
      || Date.parse(invitation.expires_at) - Date.parse(invitation.created_at) !== 7 * DAY_MS
      || invitation.expires_at <= now
      || dataKey.scope_type !== 'staff_directory'
      || dataKey.scope_id !== 'centre_1'
      || dataKey.purpose !== 'identity'
      || dataKey.dek_version !== 1
      || dataKey.kek_version !== 1
      || dataKey.created_at !== staff.created_at
      || dataKey.retired_at !== null
      || !LOOKUP.test(staff.email_lookup ?? '')
      || invitation.email_lookup !== staff.email_lookup) {
      return Object.freeze({ kind: 'refused' })
    }
    const scope = { id: 'centre_1', purpose: 'identity', type: 'staff_directory' }
    const decrypt = (recordId, field, serialized) => decryptForScope(
      keyring,
      dataKey,
      {
        expectedScope: scope,
        field,
        envelope: JSON.parse(serialized),
        recordId,
      },
    )
    const [staffEmail, staffName, invitationEmail, invitationName] = await Promise.all([
      decrypt(staff.id, 'email', staff.email_envelope),
      decrypt(staff.id, 'display_name', staff.display_name_envelope),
      decrypt(invitation.id, 'email', invitation.email_envelope),
      decrypt(invitation.id, 'display_name', invitation.display_name_envelope),
    ])
    if (staffEmail !== ownerEmail
      || invitationEmail !== ownerEmail
      || staffName !== ownerDisplayName
      || invitationName !== ownerDisplayName
      || staff.email_lookup !== await blindEmailIndex(ownerEmail, keyring, 1)) {
      return Object.freeze({ kind: 'refused' })
    }
    const staffVersion = versions.find(
      (row) => row.entity_type === 'staff_user' && row.version === 1,
    )
    const invitationVersion = versions.find(
      (row) => row.entity_type === 'staff_invitation' && row.version === 1,
    )
    const invitationPublishedVersion = versions.find(
      (row) => row.entity_type === 'staff_invitation' && row.version === 2,
    )
    const initialInvitation = published
      ? {
          ...invitation,
          access_allowed_at: null,
          status: 'provisioning',
          updated_at: invitation.created_at,
          version: 1,
        }
      : invitation
    if (!exactKeys(staffVersion, TABLE_COLUMNS.record_versions)
      || !exactKeys(invitationVersion, TABLE_COLUMNS.record_versions)
      || !ID.test(staffVersion.id ?? '')
      || !ID.test(invitationVersion.id ?? '')
      || !ID.test(staffVersion.correlation_id ?? '')
      || staffVersion.entity_id !== staff.id
      || invitationVersion.entity_id !== invitation.id
      || staffVersion.changed_by_staff_id !== null
      || invitationVersion.changed_by_staff_id !== null
      || staffVersion.changed_at !== staff.created_at
      || invitationVersion.changed_at !== staff.created_at
      || staffVersion.correlation_id !== invitationVersion.correlation_id
      || !await snapshotMatches(keyring, dataKey, scope, staffVersion, staff)
      || !await snapshotMatches(
        keyring,
        dataKey,
        scope,
        invitationVersion,
        initialInvitation,
      )
      || versions.length !== (published ? 3 : 2)
      || (published && (
        !exactKeys(invitationPublishedVersion, TABLE_COLUMNS.record_versions)
        || !ID.test(invitationPublishedVersion.id ?? '')
        || !ID.test(invitationPublishedVersion.correlation_id ?? '')
        || invitationPublishedVersion.entity_id !== invitation.id
        || invitationPublishedVersion.changed_by_staff_id !== staff.id
        || invitationPublishedVersion.changed_at !== invitation.access_allowed_at
        || !await snapshotMatches(
          keyring,
          dataKey,
          scope,
          invitationPublishedVersion,
          invitation,
        )
      ))) {
      return Object.freeze({ kind: 'refused' })
    }
    const audit = audits.find(({ action }) => action === 'staff.bootstrap')
    const accessAudit = audits.find(({ action }) => action === 'staff.access.reconciled')
    const normalizedAudit = normalizeBootstrapAuditEvent(audit)
    if (normalizedAudit.actor_staff_id !== null
      || audit.entity_id !== staff.id
      || audit.correlation_id !== staffVersion.correlation_id
      || audit.occurred_at !== staff.created_at
      || !exactKeys(normalizedAudit.metadata, [
        'desiredGeneration', 'invitationVersion', 'specialistVersion', 'staffVersion',
      ])
      || normalizedAudit.metadata.desiredGeneration !== 1
      || normalizedAudit.metadata.invitationVersion !== 1
      || normalizedAudit.metadata.specialistVersion !== null
      || normalizedAudit.metadata.staffVersion !== 1
      || audits.length !== (published ? 2 : 1)
      || (published && (
        !exactKeys(accessAudit, TABLE_COLUMNS.audit_events)
        || !ID.test(accessAudit.id ?? '')
        || !ID.test(accessAudit.correlation_id ?? '')
        || accessAudit.action !== 'staff.access.reconciled'
        || accessAudit.occurred_at !== invitation.access_allowed_at
        || accessAudit.actor_staff_id !== staff.id
        || accessAudit.entity_type !== 'access_group'
        || accessAudit.entity_id !== 'centre_1'
        || accessAudit.result !== 'success'
        || accessAudit.reason_envelope !== null
        || accessAudit.correlation_id !== invitationPublishedVersion.correlation_id
        || accessAudit.metadata_json !== JSON.stringify({
          appliedGeneration: 1,
          desiredGeneration: 1,
          invitationCount: 1,
        })
      ))) return Object.freeze({ kind: 'refused' })
    const stateByKey = new Map(states.map((row) => [row.key, row]))
    if (!sameRow(stateByKey.get('access.desired_generation'), {
      key: 'access.desired_generation',
      updated_at: staff.created_at,
      value_json: '{"generation":1}',
      version: 2,
    })) return Object.freeze({ kind: 'refused' })
    const reconcile = jobs.find(({ type }) => type === 'staff.access.reconcile')
    const expiry = jobs.find(({ type }) => type === 'staff.invitation.expire')
    const email = jobs.find(({ type }) => type === 'staff.invitation.email')
    if (!reconcile || !expiry
      || jobs.length !== (published ? 3 : 2)
      || !exactKeys(reconcile, TABLE_COLUMNS.outbox_jobs)
      || !exactKeys(expiry, TABLE_COLUMNS.outbox_jobs)
      || !ID.test(reconcile.id ?? '')
      || !ID.test(expiry.id ?? '')
      || reconcile.aggregate_type !== 'access_group'
      || reconcile.aggregate_id !== 'centre_1'
      || reconcile.idempotency_key !== 'staff.access.reconcile:1'
      || expiry.aggregate_type !== 'staff_invitation'
      || expiry.aggregate_id !== invitation.id
      || expiry.idempotency_key !== `staff.invitation.expire:${invitation.id}`
      || expiry.status !== 'queued'
      || expiry.attempt_count !== 0
      || expiry.max_attempts !== 8
      || expiry.scheduled_at !== invitation.expires_at
      || expiry.lease_owner !== null
      || expiry.lease_expires_at !== null
      || expiry.last_error_code !== null
      || expiry.created_at !== staff.created_at
      || expiry.updated_at !== staff.created_at) return Object.freeze({ kind: 'refused' })
    validateJobBase(reconcile, staff.created_at)
    validateJobBase(expiry, staff.created_at)
    const reconcileAttempts = attempts.filter(({ job_id }) => job_id === reconcile.id)
    if (reconcileAttempts.length !== attempts.length) aggregateRefused()
    let reconcileState = inspectReconcileHistory(reconcile, reconcileAttempts, now)
    const payloadJobs = published ? [reconcile, expiry, email] : [reconcile, expiry]
    if (published) {
      if (!exactKeys(email, TABLE_COLUMNS.outbox_jobs)
        || !ID.test(email.id ?? '')
        || email.aggregate_type !== 'staff_invitation'
        || email.aggregate_id !== invitation.id
        || email.idempotency_key !== `staff.invitation.email:${invitation.id}:2`
        || email.status !== 'queued'
        || email.attempt_count !== 0
        || email.max_attempts !== 8
        || email.scheduled_at !== invitation.access_allowed_at
        || email.lease_owner !== null
        || email.lease_expires_at !== null
        || email.last_error_code !== null
        || email.created_at !== invitation.access_allowed_at
        || email.updated_at !== invitation.access_allowed_at) aggregateRefused()
    }
    const payloads = await Promise.all(payloadJobs.map(
      (job) => decrypt(job.id, 'job_payload', job.payload_envelope),
    ))
    const [reconcilePayload, expiryPayload, emailPayload] = payloads
    if (reconcilePayload !== JSON.stringify({ actorId: staff.id, generation: 1 })
      || expiryPayload !== JSON.stringify({
        actorId: staff.id,
        invitationId: invitation.id,
      })
      || (published && emailPayload !== JSON.stringify({
        actorId: staff.id,
        invitationId: invitation.id,
      }))) return Object.freeze({ kind: 'refused' })

    const applied = stateByKey.get('access.applied_generation')
    const lease = stateByKey.get('access.reconcile.lease')
    let publicationAttemptIndex = null
    if (!exactReleasedLease(lease)) return Object.freeze({ kind: 'refused' })
    if (!published) {
      if (!sameRow(applied, {
        key: 'access.applied_generation',
        updated_at: '2026-07-30T00:00:00.000Z',
        value_json: JSON.stringify({
          fingerprint: EMPTY_FINGERPRINT,
          generation: 0,
        }),
        version: 1,
      })
        || reconcileState.kind === 'succeeded') return Object.freeze({ kind: 'refused' })
    } else {
      const fingerprint = await accessDesiredFingerprint([staff.email_lookup])
      if (!sameRow(applied, {
        key: 'access.applied_generation',
        updated_at: invitation.access_allowed_at,
        value_json: JSON.stringify({ fingerprint, generation: 1 }),
        version: 2,
      })
        || !['succeeded', 'queued-retry', 'processing-expired'].includes(
          reconcileState.kind,
        )) return Object.freeze({ kind: 'refused' })
      const publicationMatches = reconcileAttempts.flatMap(
        (attempt, index) => instantFallsWithinAttempt(
          invitation.access_allowed_at,
          attempt,
          now,
        ) && (
          attempt.result === 'succeeded'
          || attempt.error_code === 'OUTBOX_LEASE_EXPIRED'
          || attempt.completed_at === null
        ) ? [index] : [],
      )
      if (publicationMatches.length !== 1) return Object.freeze({ kind: 'refused' })
      publicationAttemptIndex = publicationMatches[0]
      reconcileState = Object.freeze({
        ...reconcileState,
        mandatoryAccessIndexes: Object.freeze([
          ...new Set([
            ...reconcileState.mandatoryAccessIndexes,
            publicationMatches[0],
          ]),
        ]),
      })
    }

    const leaseRuns = (lease.version - 1) / 2
    if (!Number.isSafeInteger(leaseRuns)
      || (lease.version === 1
        ? lease.updated_at !== '2026-07-30T00:00:00.000Z'
        : !leaseTimestampMatchesHistory({
            attempts: reconcileAttempts,
            leaseRuns,
            mandatoryIndexes: reconcileState.mandatoryAccessIndexes,
            now,
            possibleIndexes: reconcileState.possibleAccessIndexes,
            updatedAt: lease.updated_at,
          }))
      || (publicationAttemptIndex === reconcileAttempts.length - 1
        && lease.updated_at !== invitation.access_allowed_at)) {
      return Object.freeze({ kind: 'refused' })
    }

    const initialIds = {
      auditId: audit.id,
      dataKeyId: dataKey.id,
      expiryJobId: expiry.id,
      invitationId: invitation.id,
      invitationVersionId: invitationVersion.id,
      reconcileJobId: reconcile.id,
      staffId: staff.id,
      staffVersionId: staffVersion.id,
    }
    if (published) {
      return Object.freeze({
        ids: Object.freeze({
          accessAuditId: accessAudit.id,
          ...initialIds,
          emailJobId: email.id,
          invitationPublishedVersionId: invitationPublishedVersion.id,
        }),
        kind: 'access-published',
        reconcileState: reconcileState.kind,
      })
    }
    return Object.freeze({
      ids: Object.freeze(initialIds),
      kind: 'pre-reconcile',
      reconcileState: reconcileState.kind,
    })
  } catch {
    return Object.freeze({ kind: 'refused' })
  }
}

export async function inspectBootstrapAggregate(input = {}) {
  return inspectBootstrapAggregateFromSnapshot(input)
}

export async function inspectBootstrapEntryState(input = {}) {
  if (!input.db?.prepare || !input.db?.batch
    || !input.keyring
    || !Number.isSafeInteger(input.nowMs)
    || typeof input.ownerDisplayName !== 'string'
    || typeof input.ownerEmail !== 'string') {
    return Object.freeze({ kind: 'refused' })
  }
  try {
    const [
      dataKeys,
      staffRows,
      invitations,
      versions,
      audits,
      jobs,
      attempts,
      states,
      ...emptyTables
    ] = await snapshotRows(input.db)
    const capturedRows = [
      dataKeys,
      staffRows,
      invitations,
      versions,
      audits,
      jobs,
      attempts,
      states,
      ...emptyTables,
    ]
    if (dataKeys.length === 0
      && staffRows.length === 0
      && invitations.length === 0
      && versions.length === 0
      && audits.length === 0
      && jobs.length === 0
      && attempts.length === 0
      && emptyTables.every((rows) => rows.length === 0)
      && validAccessStateShape(states)
      && states.slice(0, GENESIS_STATES.length).every(
        (row, index) => sameRow(row, GENESIS_STATES[index]),
      )) {
      return Object.freeze({ kind: 'empty' })
    }
    return inspectBootstrapAggregateFromSnapshot(input, capturedRows)
  } catch {
    return Object.freeze({ kind: 'refused' })
  }
}
