PRAGMA foreign_keys = ON;

CREATE TABLE activity_programs (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(CAST(id AS BLOB))=length(id) AND length(id) BETWEEN 5 AND 128
    AND substr(id,1,4)='apg_' AND substr(id,5,1) GLOB '[A-Za-z0-9]'
    AND substr(id,5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  code TEXT NOT NULL UNIQUE CHECK (code IN ('tus','english')),
  label TEXT NOT NULL CHECK (
    label=trim(label) AND length(CAST(label AS BLOB)) BETWEEN 1 AND 80
  ),
  status TEXT NOT NULL CHECK (status IN ('active','inactive')),
  version INTEGER NOT NULL CHECK (typeof(version)='integer' AND version>=1),
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ',julianday(created_at))
  ),
  updated_at TEXT NOT NULL CHECK (
    updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ',julianday(updated_at))
    AND updated_at>=created_at
  ),
  CHECK (id='apg_'||code)
);

INSERT INTO activity_programs
  (id,code,label,status,version,created_at,updated_at)
VALUES
  ('apg_english','english','Język angielski','active',1,
   '1970-01-01T00:00:00.000Z','1970-01-01T00:00:00.000Z'),
  ('apg_tus','tus','TUS','active',1,
   '1970-01-01T00:00:00.000Z','1970-01-01T00:00:00.000Z');

CREATE TRIGGER activity_programs_immutable_identity
BEFORE UPDATE ON activity_programs
WHEN OLD.id!=NEW.id OR OLD.code!=NEW.code OR OLD.created_at!=NEW.created_at
BEGIN SELECT RAISE(ABORT,'immutable_activity_program_identity'); END;
CREATE TRIGGER activity_programs_version_increment
BEFORE UPDATE ON activity_programs
WHEN typeof(NEW.version)!='integer' OR NEW.version!=OLD.version+1
BEGIN SELECT RAISE(ABORT,'invalid_version_increment'); END;
CREATE TRIGGER activity_programs_inactivation_guard
BEFORE UPDATE OF status ON activity_programs
WHEN OLD.status='active' AND NEW.status='inactive' AND (
  EXISTS (SELECT 1 FROM activity_groups AS activity_group
    WHERE activity_group.program_id=OLD.id AND activity_group.status='active')
  OR EXISTS (SELECT 1 FROM activity_participants AS participant
    WHERE participant.program_id=OLD.id AND participant.status='active')
  OR EXISTS (SELECT 1 FROM activity_charges AS charge
    WHERE charge.program_id=OLD.id AND charge.status='active')
) BEGIN SELECT RAISE(ABORT,'activity_program_active_dependents'); END;
CREATE TRIGGER activity_programs_no_delete BEFORE DELETE ON activity_programs
BEGIN SELECT RAISE(ABORT,'no_routine_delete'); END;

CREATE TABLE activity_groups (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(CAST(id AS BLOB))=length(id) AND length(id) BETWEEN 5 AND 128
    AND substr(id,1,4)='agr_' AND substr(id,5,1) GLOB '[A-Za-z0-9]'
    AND substr(id,5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  program_id TEXT NOT NULL REFERENCES activity_programs(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  label_envelope TEXT NOT NULL CHECK (
    json_valid(label_envelope) AND json_type(label_envelope)='object'
  ),
  details_envelope TEXT CHECK (
    details_envelope IS NULL OR (
      json_valid(details_envelope) AND json_type(details_envelope)='object'
    )
  ),
  status TEXT NOT NULL CHECK (status IN ('active','inactive')),
  version INTEGER NOT NULL CHECK (typeof(version)='integer' AND version>=1),
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ',julianday(created_at))
  ),
  updated_at TEXT NOT NULL CHECK (
    updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ',julianday(updated_at))
    AND updated_at>=created_at
  )
);
CREATE INDEX activity_groups_program_status_id_idx
  ON activity_groups (program_id,status,id);
CREATE TRIGGER activity_groups_active_program_insert
BEFORE INSERT ON activity_groups WHEN NOT EXISTS (
  SELECT 1 FROM activity_programs AS program
  WHERE program.id=NEW.program_id AND program.status='active'
) BEGIN SELECT RAISE(ABORT,'activity_group_inactive_program'); END;
CREATE TRIGGER activity_groups_active_program_update
BEFORE UPDATE OF status ON activity_groups
WHEN NEW.status='active' AND NOT EXISTS (
  SELECT 1 FROM activity_programs AS program
  WHERE program.id=NEW.program_id AND program.status='active'
) BEGIN SELECT RAISE(ABORT,'activity_group_inactive_program'); END;
CREATE TRIGGER activity_groups_inactivation_guard
BEFORE UPDATE OF status ON activity_groups
WHEN OLD.status='active' AND NEW.status='inactive' AND (
  EXISTS (SELECT 1 FROM activity_group_leaders AS leader
    WHERE leader.group_id=OLD.id AND leader.status='active')
  OR EXISTS (SELECT 1 FROM activity_memberships AS membership
    WHERE membership.group_id=OLD.id AND membership.membership_kind='interval'
      AND membership.status='active')
  OR EXISTS (SELECT 1 FROM activity_classes AS activity_class
    WHERE activity_class.group_id=OLD.id AND activity_class.status='scheduled')
) BEGIN SELECT RAISE(ABORT,'activity_group_active_dependents'); END;
CREATE TRIGGER activity_groups_immutable_identity BEFORE UPDATE ON activity_groups
WHEN OLD.id!=NEW.id OR OLD.program_id!=NEW.program_id OR OLD.created_at!=NEW.created_at
BEGIN SELECT RAISE(ABORT,'immutable_activity_group_identity'); END;
CREATE TRIGGER activity_groups_version_increment BEFORE UPDATE ON activity_groups
WHEN typeof(NEW.version)!='integer' OR NEW.version!=OLD.version+1
BEGIN SELECT RAISE(ABORT,'invalid_version_increment'); END;
CREATE TRIGGER activity_groups_no_delete BEFORE DELETE ON activity_groups
BEGIN SELECT RAISE(ABORT,'no_routine_delete'); END;

CREATE TABLE activity_group_lookup_aliases (
  group_id TEXT NOT NULL REFERENCES activity_groups(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  program_id TEXT NOT NULL REFERENCES activity_programs(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  domain TEXT NOT NULL CHECK (domain='bwm:activity-group:v1'),
  hmac_version INTEGER NOT NULL CHECK (typeof(hmac_version)='integer' AND hmac_version>=1),
  lookup_digest TEXT NOT NULL CHECK (
    length(lookup_digest)=43 AND lookup_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ',julianday(created_at))
  ),
  PRIMARY KEY (group_id,hmac_version,lookup_digest),
  UNIQUE (program_id,domain,hmac_version,lookup_digest)
);
CREATE TRIGGER activity_group_lookup_program_guard
BEFORE INSERT ON activity_group_lookup_aliases WHEN NOT EXISTS (
  SELECT 1 FROM activity_groups AS target
  WHERE target.id=NEW.group_id AND target.program_id=NEW.program_id
) BEGIN SELECT RAISE(ABORT,'activity_group_lookup_program_mismatch'); END;
CREATE TRIGGER activity_group_lookup_no_update BEFORE UPDATE ON activity_group_lookup_aliases
BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER activity_group_lookup_no_delete BEFORE DELETE ON activity_group_lookup_aliases
BEGIN SELECT RAISE(ABORT,'append_only'); END;

CREATE TABLE activity_group_leaders (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(CAST(id AS BLOB))=length(id) AND length(id) BETWEEN 5 AND 128
    AND substr(id,1,4)='agl_' AND substr(id,5,1) GLOB '[A-Za-z0-9]'
    AND substr(id,5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  group_id TEXT NOT NULL REFERENCES activity_groups(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  specialist_id TEXT NOT NULL REFERENCES specialists(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  starts_on TEXT NOT NULL CHECK (
    starts_on IS strftime('%Y-%m-%d',starts_on)
    AND starts_on=date(starts_on,'+0 days') AND substr(starts_on,1,4)!='0000'
  ),
  ends_on TEXT CHECK (
    ends_on IS NULL OR (ends_on IS strftime('%Y-%m-%d',ends_on)
      AND ends_on=date(ends_on,'+0 days') AND substr(ends_on,1,4)!='0000'
      AND ends_on>=starts_on)
  ),
  status TEXT NOT NULL CHECK (status IN ('active','inactive')),
  version INTEGER NOT NULL CHECK (typeof(version)='integer' AND version>=1),
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ',julianday(created_at))
  ),
  updated_at TEXT NOT NULL CHECK (
    updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ',julianday(updated_at))
    AND updated_at>=created_at
  )
);
CREATE INDEX activity_group_leaders_specialist_group_idx
  ON activity_group_leaders (specialist_id,status,group_id,id);
CREATE UNIQUE INDEX activity_group_leaders_current_idx
  ON activity_group_leaders (group_id,specialist_id)
  WHERE status='active' AND ends_on IS NULL;
CREATE TRIGGER activity_group_leaders_active_graph_insert
BEFORE INSERT ON activity_group_leaders WHEN NOT EXISTS (
  SELECT 1 FROM activity_groups AS activity_group
  JOIN specialists AS specialist ON specialist.id=NEW.specialist_id
  WHERE activity_group.id=NEW.group_id AND activity_group.status='active'
    AND specialist.status='active'
) BEGIN SELECT RAISE(ABORT,'activity_group_leader_inactive_graph'); END;
CREATE TRIGGER activity_group_leaders_active_graph_update
BEFORE UPDATE OF status,starts_on,ends_on ON activity_group_leaders
WHEN NEW.status='active' AND NOT EXISTS (
  SELECT 1 FROM activity_groups AS activity_group
  JOIN specialists AS specialist ON specialist.id=NEW.specialist_id
  WHERE activity_group.id=NEW.group_id AND activity_group.status='active'
    AND specialist.status='active'
) BEGIN SELECT RAISE(ABORT,'activity_group_leader_inactive_graph'); END;
CREATE TRIGGER activity_group_leaders_overlap_insert
BEFORE INSERT ON activity_group_leaders WHEN EXISTS (
  SELECT 1 FROM activity_group_leaders AS existing
  WHERE existing.group_id=NEW.group_id AND existing.specialist_id=NEW.specialist_id
    AND existing.status='active' AND NEW.status='active'
    AND existing.starts_on<=coalesce(NEW.ends_on,'9999-12-31')
    AND NEW.starts_on<=coalesce(existing.ends_on,'9999-12-31')
) BEGIN SELECT RAISE(ABORT,'activity_group_leader_overlap'); END;
CREATE TRIGGER activity_group_leaders_overlap_update
BEFORE UPDATE ON activity_group_leaders WHEN EXISTS (
  SELECT 1 FROM activity_group_leaders AS existing
  WHERE existing.id!=OLD.id AND existing.group_id=NEW.group_id
    AND existing.specialist_id=NEW.specialist_id
    AND existing.status='active' AND NEW.status='active'
    AND existing.starts_on<=coalesce(NEW.ends_on,'9999-12-31')
    AND NEW.starts_on<=coalesce(existing.ends_on,'9999-12-31')
) BEGIN SELECT RAISE(ABORT,'activity_group_leader_overlap'); END;
CREATE TRIGGER activity_group_leaders_immutable_identity
BEFORE UPDATE ON activity_group_leaders
WHEN OLD.id!=NEW.id OR OLD.group_id!=NEW.group_id OR OLD.specialist_id!=NEW.specialist_id
  OR OLD.created_at!=NEW.created_at
BEGIN SELECT RAISE(ABORT,'immutable_activity_group_leader_identity'); END;
CREATE TRIGGER activity_group_leaders_version_increment
BEFORE UPDATE ON activity_group_leaders
WHEN typeof(NEW.version)!='integer' OR NEW.version!=OLD.version+1
BEGIN SELECT RAISE(ABORT,'invalid_version_increment'); END;
CREATE TRIGGER activity_group_leaders_no_delete BEFORE DELETE ON activity_group_leaders
BEGIN SELECT RAISE(ABORT,'no_routine_delete'); END;

CREATE TABLE activity_participants (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(CAST(id AS BLOB))=length(id) AND length(id) BETWEEN 5 AND 128
    AND substr(id,1,4)='acp_' AND substr(id,5,1) GLOB '[A-Za-z0-9]'
    AND substr(id,5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  program_id TEXT NOT NULL REFERENCES activity_programs(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  identity_envelope TEXT NOT NULL CHECK (
    json_valid(identity_envelope) AND json_type(identity_envelope)='object'
  ),
  client_id TEXT REFERENCES clients(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  historical_client_id TEXT REFERENCES historical_clients(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('active','inactive')),
  version INTEGER NOT NULL CHECK (typeof(version)='integer' AND version>=1),
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ',julianday(created_at))
  ),
  updated_at TEXT NOT NULL CHECK (
    updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ',julianday(updated_at))
    AND updated_at>=created_at
  ),
  CHECK (client_id IS NULL OR historical_client_id IS NULL)
);
CREATE INDEX activity_participants_program_status_id_idx
  ON activity_participants (program_id,status,id);
CREATE INDEX activity_participants_client_idx ON activity_participants (client_id,id);
CREATE INDEX activity_participants_historical_idx
  ON activity_participants (historical_client_id,id);
CREATE TRIGGER activity_participants_active_program_insert
BEFORE INSERT ON activity_participants WHEN NOT EXISTS (
  SELECT 1 FROM activity_programs AS program
  WHERE program.id=NEW.program_id AND program.status='active'
) BEGIN SELECT RAISE(ABORT,'activity_participant_inactive_program'); END;
CREATE TRIGGER activity_participants_active_program_update
BEFORE UPDATE OF status ON activity_participants
WHEN NEW.status='active' AND NOT EXISTS (
  SELECT 1 FROM activity_programs AS program
  WHERE program.id=NEW.program_id AND program.status='active'
) BEGIN SELECT RAISE(ABORT,'activity_participant_inactive_program'); END;
CREATE TRIGGER activity_participants_inactivation_guard
BEFORE UPDATE OF status ON activity_participants
WHEN OLD.status='active' AND NEW.status='inactive' AND (
  EXISTS (SELECT 1 FROM activity_memberships AS membership
    WHERE membership.participant_id=OLD.id AND membership.membership_kind='interval'
      AND membership.status='active')
  OR EXISTS (SELECT 1 FROM activity_attendance AS attendance
    JOIN activity_classes AS activity_class ON activity_class.id=attendance.class_id
    WHERE attendance.participant_id=OLD.id AND activity_class.status='scheduled')
) BEGIN SELECT RAISE(ABORT,'activity_participant_active_dependents'); END;
CREATE TRIGGER activity_participants_immutable_identity
BEFORE UPDATE ON activity_participants
WHEN OLD.id!=NEW.id OR OLD.program_id!=NEW.program_id OR OLD.created_at!=NEW.created_at
BEGIN SELECT RAISE(ABORT,'immutable_activity_participant_identity'); END;
CREATE TRIGGER activity_participants_version_increment
BEFORE UPDATE ON activity_participants
WHEN typeof(NEW.version)!='integer' OR NEW.version!=OLD.version+1
BEGIN SELECT RAISE(ABORT,'invalid_version_increment'); END;
CREATE TRIGGER activity_participants_no_delete BEFORE DELETE ON activity_participants
BEGIN SELECT RAISE(ABORT,'no_routine_delete'); END;

CREATE TABLE activity_participant_lookup_aliases (
  participant_id TEXT NOT NULL REFERENCES activity_participants(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  program_id TEXT NOT NULL REFERENCES activity_programs(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  domain TEXT NOT NULL CHECK (domain='bwm:activity-participant:v1'),
  hmac_version INTEGER NOT NULL CHECK (typeof(hmac_version)='integer' AND hmac_version>=1),
  lookup_digest TEXT NOT NULL CHECK (
    length(lookup_digest)=43 AND lookup_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ',julianday(created_at))
  ),
  PRIMARY KEY (participant_id,hmac_version,lookup_digest),
  UNIQUE (program_id,domain,hmac_version,lookup_digest)
);
CREATE TRIGGER activity_participant_lookup_program_guard
BEFORE INSERT ON activity_participant_lookup_aliases WHEN NOT EXISTS (
  SELECT 1 FROM activity_participants AS target
  WHERE target.id=NEW.participant_id AND target.program_id=NEW.program_id
) BEGIN SELECT RAISE(ABORT,'activity_participant_lookup_program_mismatch'); END;
CREATE TRIGGER activity_participant_lookup_no_update
BEFORE UPDATE ON activity_participant_lookup_aliases
BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER activity_participant_lookup_no_delete
BEFORE DELETE ON activity_participant_lookup_aliases
BEGIN SELECT RAISE(ABORT,'append_only'); END;

CREATE TABLE activity_memberships (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(CAST(id AS BLOB))=length(id) AND length(id) BETWEEN 5 AND 128
    AND substr(id,1,4)='amb_' AND substr(id,5,1) GLOB '[A-Za-z0-9]'
    AND substr(id,5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  participant_id TEXT NOT NULL REFERENCES activity_participants(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  program_id TEXT NOT NULL REFERENCES activity_programs(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  group_id TEXT NOT NULL REFERENCES activity_groups(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  membership_kind TEXT NOT NULL CHECK (membership_kind IN ('observation','interval')),
  period_precision TEXT NOT NULL CHECK (period_precision IN ('day','month','unknown')),
  observed_on TEXT CHECK (
    observed_on IS NULL OR (observed_on IS strftime('%Y-%m-%d',observed_on)
      AND observed_on=date(observed_on,'+0 days') AND substr(observed_on,1,4)!='0000')
  ),
  observed_month TEXT CHECK (
    observed_month IS NULL OR (
      observed_month IS strftime('%Y-%m',observed_month||'-01')
      AND observed_month||'-01'=date(observed_month||'-01','+0 days')
      AND substr(observed_month,1,4)!='0000')
  ),
  starts_on TEXT CHECK (starts_on IS NULL OR (
    starts_on IS strftime('%Y-%m-%d',starts_on)
    AND starts_on=date(starts_on,'+0 days') AND substr(starts_on,1,4)!='0000'
  )),
  ends_on TEXT CHECK (
    ends_on IS NULL OR (ends_on IS strftime('%Y-%m-%d',ends_on)
      AND ends_on=date(ends_on,'+0 days') AND substr(ends_on,1,4)!='0000'
      AND ends_on>=starts_on)
  ),
  status TEXT NOT NULL CHECK (status IN ('active','inactive')),
  version INTEGER NOT NULL CHECK (typeof(version)='integer' AND version>=1),
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ',julianday(created_at))
  ),
  updated_at TEXT NOT NULL CHECK (
    updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ',julianday(updated_at))
    AND updated_at>=created_at
  ),
  CHECK (
    (membership_kind='observation' AND period_precision='day'
      AND observed_on IS NOT NULL AND observed_month=substr(observed_on,1,7)
      AND starts_on IS NULL AND ends_on IS NULL)
    OR (membership_kind='observation' AND period_precision='month'
      AND observed_on IS NULL AND observed_month IS NOT NULL
      AND starts_on IS NULL AND ends_on IS NULL)
    OR (membership_kind='interval' AND period_precision='unknown'
      AND observed_on IS NULL AND observed_month IS NULL AND starts_on IS NOT NULL)
  )
);
CREATE INDEX activity_memberships_group_status_id_idx
  ON activity_memberships (group_id,status,id);
CREATE INDEX activity_memberships_participant_program_idx
  ON activity_memberships (participant_id,program_id,status,id);
CREATE INDEX activity_memberships_month_idx
  ON activity_memberships (observed_month,program_id,id);
CREATE UNIQUE INDEX activity_memberships_day_observation_idx
  ON activity_memberships (participant_id,group_id,observed_on)
  WHERE membership_kind='observation' AND period_precision='day';
CREATE UNIQUE INDEX activity_memberships_month_observation_idx
  ON activity_memberships (participant_id,group_id,observed_month)
  WHERE membership_kind='observation' AND period_precision='month';
CREATE UNIQUE INDEX activity_memberships_current_group_idx
  ON activity_memberships (participant_id,program_id)
  WHERE membership_kind='interval' AND status='active' AND ends_on IS NULL;
CREATE TRIGGER activity_memberships_program_insert
BEFORE INSERT ON activity_memberships WHEN NOT EXISTS (
  SELECT 1 FROM activity_participants AS participant
  JOIN activity_groups AS activity_group ON activity_group.id=NEW.group_id
  JOIN activity_programs AS program ON program.id=NEW.program_id
  WHERE participant.id=NEW.participant_id
    AND participant.program_id=NEW.program_id
    AND activity_group.program_id=NEW.program_id
    AND program.id=NEW.program_id
) BEGIN SELECT RAISE(ABORT,'activity_membership_program_mismatch'); END;
CREATE TRIGGER activity_memberships_program_update
BEFORE UPDATE ON activity_memberships WHEN NOT EXISTS (
  SELECT 1 FROM activity_participants AS participant
  JOIN activity_groups AS activity_group ON activity_group.id=NEW.group_id
  JOIN activity_programs AS program ON program.id=NEW.program_id
  WHERE participant.id=NEW.participant_id
    AND participant.program_id=NEW.program_id
    AND activity_group.program_id=NEW.program_id
    AND program.id=NEW.program_id
) BEGIN SELECT RAISE(ABORT,'activity_membership_program_mismatch'); END;
CREATE TRIGGER activity_memberships_active_graph_insert
BEFORE INSERT ON activity_memberships WHEN EXISTS (
  SELECT 1 FROM activity_participants AS participant
  JOIN activity_groups AS activity_group ON activity_group.id=NEW.group_id
  WHERE participant.id=NEW.participant_id
    AND participant.program_id=NEW.program_id
    AND activity_group.program_id=NEW.program_id
) AND NOT EXISTS (
  SELECT 1 FROM activity_participants AS participant
  JOIN activity_groups AS activity_group ON activity_group.id=NEW.group_id
  JOIN activity_programs AS program ON program.id=NEW.program_id
  WHERE participant.id=NEW.participant_id
    AND participant.program_id=NEW.program_id
    AND activity_group.program_id=NEW.program_id
    AND participant.status='active' AND activity_group.status='active'
    AND program.status='active'
) BEGIN SELECT RAISE(ABORT,'activity_membership_inactive_graph'); END;
CREATE TRIGGER activity_memberships_active_graph_update
BEFORE UPDATE OF status ON activity_memberships
WHEN NEW.status='active' AND EXISTS (
  SELECT 1 FROM activity_participants AS participant
  JOIN activity_groups AS activity_group ON activity_group.id=NEW.group_id
  WHERE participant.id=NEW.participant_id
    AND participant.program_id=NEW.program_id
    AND activity_group.program_id=NEW.program_id
) AND NOT EXISTS (
  SELECT 1 FROM activity_participants AS participant
  JOIN activity_groups AS activity_group ON activity_group.id=NEW.group_id
  JOIN activity_programs AS program ON program.id=NEW.program_id
  WHERE participant.id=NEW.participant_id
    AND participant.program_id=NEW.program_id
    AND activity_group.program_id=NEW.program_id
    AND participant.status='active' AND activity_group.status='active'
    AND program.status='active'
) BEGIN SELECT RAISE(ABORT,'activity_membership_inactive_graph'); END;
CREATE TRIGGER activity_memberships_overlap_insert
BEFORE INSERT ON activity_memberships
WHEN NEW.membership_kind='interval' AND EXISTS (
  SELECT 1 FROM activity_memberships AS existing
  WHERE existing.participant_id=NEW.participant_id AND existing.program_id=NEW.program_id
    AND existing.membership_kind='interval'
    AND existing.starts_on<=coalesce(NEW.ends_on,'9999-12-31')
    AND NEW.starts_on<=coalesce(existing.ends_on,'9999-12-31')
) BEGIN SELECT RAISE(ABORT,'activity_membership_overlap'); END;
CREATE TRIGGER activity_memberships_overlap_update
BEFORE UPDATE ON activity_memberships
WHEN NEW.membership_kind='interval' AND EXISTS (
  SELECT 1 FROM activity_memberships AS existing
  WHERE existing.id!=OLD.id AND existing.participant_id=NEW.participant_id
    AND existing.program_id=NEW.program_id AND existing.membership_kind='interval'
    AND existing.starts_on<=coalesce(NEW.ends_on,'9999-12-31')
    AND NEW.starts_on<=coalesce(existing.ends_on,'9999-12-31')
) BEGIN SELECT RAISE(ABORT,'activity_membership_overlap'); END;
CREATE TRIGGER activity_memberships_attendance_reverse_guard
BEFORE UPDATE OF participant_id,program_id,group_id,membership_kind,period_precision,
  observed_on,observed_month,starts_on,ends_on,status ON activity_memberships
WHEN EXISTS (
  SELECT 1 FROM activity_attendance AS attendance
  JOIN activity_classes AS activity_class ON activity_class.id=attendance.class_id
  WHERE attendance.participant_id=OLD.participant_id
    AND activity_class.group_id=OLD.group_id
    AND NOT (
      (NEW.participant_id=attendance.participant_id
        AND NEW.group_id=activity_class.group_id AND (
          (NEW.membership_kind='interval' AND NEW.starts_on<=activity_class.occurs_on
            AND coalesce(NEW.ends_on,'9999-12-31')>=activity_class.occurs_on)
          OR (NEW.membership_kind='observation' AND NEW.period_precision='day'
            AND NEW.observed_on=activity_class.occurs_on)
          OR (NEW.membership_kind='observation' AND NEW.period_precision='month'
            AND NEW.observed_month=substr(activity_class.occurs_on,1,7))
        ))
      OR EXISTS (
        SELECT 1 FROM activity_memberships AS alternative
        WHERE alternative.id!=OLD.id
          AND alternative.participant_id=attendance.participant_id
          AND alternative.group_id=activity_class.group_id AND (
            (alternative.membership_kind='interval'
              AND alternative.starts_on<=activity_class.occurs_on
              AND coalesce(alternative.ends_on,'9999-12-31')>=activity_class.occurs_on)
            OR (alternative.membership_kind='observation'
              AND alternative.period_precision='day'
              AND alternative.observed_on=activity_class.occurs_on)
            OR (alternative.membership_kind='observation'
              AND alternative.period_precision='month'
              AND alternative.observed_month=substr(activity_class.occurs_on,1,7))
          )
      )
    )
) BEGIN SELECT RAISE(ABORT,'activity_membership_attendance_stranded'); END;
CREATE TRIGGER activity_memberships_immutable_identity
BEFORE UPDATE ON activity_memberships
WHEN OLD.id!=NEW.id OR OLD.participant_id!=NEW.participant_id
  OR OLD.program_id!=NEW.program_id OR OLD.group_id!=NEW.group_id
  OR OLD.membership_kind!=NEW.membership_kind OR OLD.created_at!=NEW.created_at
BEGIN SELECT RAISE(ABORT,'immutable_activity_membership_identity'); END;
CREATE TRIGGER activity_memberships_version_increment
BEFORE UPDATE ON activity_memberships
WHEN typeof(NEW.version)!='integer' OR NEW.version!=OLD.version+1
BEGIN SELECT RAISE(ABORT,'invalid_version_increment'); END;
CREATE TRIGGER activity_memberships_no_delete BEFORE DELETE ON activity_memberships
BEGIN SELECT RAISE(ABORT,'no_routine_delete'); END;

CREATE TABLE activity_classes (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(CAST(id AS BLOB))=length(id) AND length(id) BETWEEN 5 AND 128
    AND substr(id,1,4)='acl_' AND substr(id,5,1) GLOB '[A-Za-z0-9]'
    AND substr(id,5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  group_id TEXT NOT NULL REFERENCES activity_groups(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  occurs_on TEXT NOT NULL CHECK (
    occurs_on IS strftime('%Y-%m-%d',occurs_on)
    AND occurs_on=date(occurs_on,'+0 days') AND substr(occurs_on,1,4)!='0000'
  ),
  wall_time TEXT CHECK (
    wall_time IS NULL OR (length(wall_time)=5 AND wall_time GLOB '[0-2][0-9]:[0-5][0-9]'
      AND substr(wall_time,1,2)<='23')
  ),
  duration_minutes INTEGER CHECK (
    duration_minutes IS NULL OR (
      typeof(duration_minutes)='integer' AND duration_minutes BETWEEN 1 AND 1440
    )
  ),
  topic_envelope TEXT CHECK (
    topic_envelope IS NULL OR (json_valid(topic_envelope) AND json_type(topic_envelope)='object')
  ),
  status TEXT NOT NULL CHECK (status IN ('scheduled','completed','cancelled')),
  version INTEGER NOT NULL CHECK (typeof(version)='integer' AND version>=1),
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ',julianday(created_at))
  ),
  updated_at TEXT NOT NULL CHECK (
    updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ',julianday(updated_at))
    AND updated_at>=created_at
  )
);
CREATE INDEX activity_classes_group_day_id_idx ON activity_classes (group_id,occurs_on,id);
CREATE INDEX activity_classes_day_id_idx ON activity_classes (occurs_on,id);
CREATE TRIGGER activity_classes_active_group_insert
BEFORE INSERT ON activity_classes WHEN NOT EXISTS (
  SELECT 1 FROM activity_groups AS activity_group
  WHERE activity_group.id=NEW.group_id AND activity_group.status='active'
) BEGIN SELECT RAISE(ABORT,'activity_class_inactive_group'); END;
CREATE TRIGGER activity_classes_active_group_update
BEFORE UPDATE ON activity_classes
WHEN NEW.status='scheduled' AND NOT EXISTS (
  SELECT 1 FROM activity_groups AS activity_group
  WHERE activity_group.id=NEW.group_id AND activity_group.status='active'
) BEGIN SELECT RAISE(ABORT,'activity_class_inactive_group'); END;
CREATE TRIGGER activity_classes_attendance_status_guard
BEFORE UPDATE OF status ON activity_classes
WHEN NEW.status='cancelled' AND EXISTS (
  SELECT 1 FROM activity_attendance AS attendance WHERE attendance.class_id=OLD.id
) BEGIN SELECT RAISE(ABORT,'activity_class_active_attendance'); END;
CREATE TRIGGER activity_classes_attendance_reverse_guard
BEFORE UPDATE OF occurs_on ON activity_classes WHEN EXISTS (
  SELECT 1 FROM activity_attendance AS attendance
  WHERE attendance.class_id=OLD.id AND NOT EXISTS (
    SELECT 1 FROM activity_memberships AS membership
    WHERE membership.participant_id=attendance.participant_id
      AND membership.group_id=NEW.group_id AND (
        (membership.membership_kind='interval'
          AND membership.starts_on<=NEW.occurs_on
          AND coalesce(membership.ends_on,'9999-12-31')>=NEW.occurs_on)
        OR (membership.membership_kind='observation'
          AND membership.period_precision='day' AND membership.observed_on=NEW.occurs_on)
        OR (membership.membership_kind='observation'
          AND membership.period_precision='month'
          AND membership.observed_month=substr(NEW.occurs_on,1,7))
      )
  )
) BEGIN SELECT RAISE(ABORT,'activity_class_attendance_stranded'); END;
CREATE TRIGGER activity_classes_immutable_identity BEFORE UPDATE ON activity_classes
WHEN OLD.id!=NEW.id OR OLD.group_id!=NEW.group_id OR OLD.created_at!=NEW.created_at
BEGIN SELECT RAISE(ABORT,'immutable_activity_class_identity'); END;
CREATE TRIGGER activity_classes_version_increment BEFORE UPDATE ON activity_classes
WHEN typeof(NEW.version)!='integer' OR NEW.version!=OLD.version+1
BEGIN SELECT RAISE(ABORT,'invalid_version_increment'); END;
CREATE TRIGGER activity_classes_no_delete BEFORE DELETE ON activity_classes
BEGIN SELECT RAISE(ABORT,'no_routine_delete'); END;

CREATE TABLE activity_attendance (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(CAST(id AS BLOB))=length(id) AND length(id) BETWEEN 5 AND 128
    AND substr(id,1,4)='aat_' AND substr(id,5,1) GLOB '[A-Za-z0-9]'
    AND substr(id,5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  class_id TEXT NOT NULL REFERENCES activity_classes(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  participant_id TEXT NOT NULL REFERENCES activity_participants(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('present','absent','excused','unknown')),
  version INTEGER NOT NULL CHECK (typeof(version)='integer' AND version>=1),
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ',julianday(created_at))
  ),
  updated_at TEXT NOT NULL CHECK (
    updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ',julianday(updated_at))
    AND updated_at>=created_at
  ),
  UNIQUE (class_id,participant_id)
);
CREATE INDEX activity_attendance_participant_class_idx
  ON activity_attendance (participant_id,class_id,id);
CREATE TRIGGER activity_attendance_eligibility_insert
BEFORE INSERT ON activity_attendance WHEN NOT EXISTS (
  SELECT 1 FROM activity_classes AS activity_class
  JOIN activity_groups AS activity_group ON activity_group.id=activity_class.group_id
    AND activity_group.status='active'
  JOIN activity_participants AS participant ON participant.id=NEW.participant_id
    AND participant.program_id=activity_group.program_id AND participant.status='active'
  JOIN activity_memberships AS membership ON membership.participant_id=participant.id
    AND membership.group_id=activity_group.id AND membership.program_id=participant.program_id
    AND membership.status='active'
  WHERE activity_class.id=NEW.class_id AND activity_class.status!='cancelled' AND (
    (membership.membership_kind='interval'
      AND membership.starts_on<=activity_class.occurs_on
      AND coalesce(membership.ends_on,'9999-12-31')>=activity_class.occurs_on)
    OR (membership.membership_kind='observation' AND membership.period_precision='day'
      AND membership.observed_on=activity_class.occurs_on)
    OR (membership.membership_kind='observation' AND membership.period_precision='month'
      AND membership.observed_month=substr(activity_class.occurs_on,1,7))
  )
) BEGIN SELECT RAISE(ABORT,'activity_attendance_not_eligible'); END;
CREATE TRIGGER activity_attendance_eligibility_update
BEFORE UPDATE ON activity_attendance WHEN NOT EXISTS (
  SELECT 1 FROM activity_classes AS activity_class
  JOIN activity_groups AS activity_group ON activity_group.id=activity_class.group_id
  JOIN activity_participants AS participant ON participant.id=NEW.participant_id
    AND participant.program_id=activity_group.program_id
  JOIN activity_memberships AS membership ON membership.participant_id=participant.id
    AND membership.group_id=activity_group.id AND membership.program_id=participant.program_id
  WHERE activity_class.id=NEW.class_id AND activity_class.status!='cancelled' AND (
    (membership.membership_kind='interval'
      AND membership.starts_on<=activity_class.occurs_on
      AND coalesce(membership.ends_on,'9999-12-31')>=activity_class.occurs_on)
    OR (membership.membership_kind='observation' AND membership.period_precision='day'
      AND membership.observed_on=activity_class.occurs_on)
    OR (membership.membership_kind='observation' AND membership.period_precision='month'
      AND membership.observed_month=substr(activity_class.occurs_on,1,7))
  )
) BEGIN SELECT RAISE(ABORT,'activity_attendance_not_eligible'); END;
CREATE TRIGGER activity_attendance_immutable_identity
BEFORE UPDATE ON activity_attendance
WHEN OLD.id!=NEW.id OR OLD.class_id!=NEW.class_id OR OLD.participant_id!=NEW.participant_id
  OR OLD.created_at!=NEW.created_at
BEGIN SELECT RAISE(ABORT,'immutable_activity_attendance_identity'); END;
CREATE TRIGGER activity_attendance_version_increment
BEFORE UPDATE ON activity_attendance
WHEN typeof(NEW.version)!='integer' OR NEW.version!=OLD.version+1
BEGIN SELECT RAISE(ABORT,'invalid_version_increment'); END;
CREATE TRIGGER activity_attendance_no_delete BEFORE DELETE ON activity_attendance
BEGIN SELECT RAISE(ABORT,'no_routine_delete'); END;

CREATE TABLE activity_charges (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(CAST(id AS BLOB))=length(id) AND length(id) BETWEEN 5 AND 128
    AND substr(id,1,4)='ach_' AND substr(id,5,1) GLOB '[A-Za-z0-9]'
    AND substr(id,5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  participant_id TEXT NOT NULL REFERENCES activity_participants(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  program_id TEXT NOT NULL REFERENCES activity_programs(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  group_id TEXT REFERENCES activity_groups(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  membership_id TEXT REFERENCES activity_memberships(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  period_precision TEXT NOT NULL CHECK (period_precision IN ('day','month')),
  occurred_on TEXT CHECK (
    occurred_on IS NULL OR (occurred_on IS strftime('%Y-%m-%d',occurred_on)
      AND occurred_on=date(occurred_on,'+0 days') AND substr(occurred_on,1,4)!='0000')
  ),
  accounting_month TEXT NOT NULL CHECK (
    accounting_month IS strftime('%Y-%m',accounting_month||'-01')
    AND accounting_month||'-01'=date(accounting_month||'-01','+0 days')
    AND substr(accounting_month,1,4)!='0000'
  ),
  lesson_count INTEGER CHECK (
    lesson_count IS NULL OR (typeof(lesson_count)='integer' AND lesson_count BETWEEN 0 AND 1000)
  ),
  responsible_specialist_id TEXT NOT NULL REFERENCES specialists(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  finance_entry_id TEXT NOT NULL UNIQUE REFERENCES finance_entries(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('active','inactive')),
  version INTEGER NOT NULL CHECK (typeof(version)='integer' AND version>=1),
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ',julianday(created_at))
  ),
  updated_at TEXT NOT NULL CHECK (
    updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ',julianday(updated_at))
    AND updated_at>=created_at
  ),
  CHECK (
    (period_precision='day' AND occurred_on IS NOT NULL
      AND accounting_month=substr(occurred_on,1,7))
    OR (period_precision='month' AND occurred_on IS NULL)
  ),
  CHECK ((group_id IS NULL)=(membership_id IS NULL))
);
CREATE INDEX activity_charges_month_program_id_idx
  ON activity_charges (accounting_month,program_id,status,id);
CREATE INDEX activity_charges_specialist_month_id_idx
  ON activity_charges (responsible_specialist_id,accounting_month,status,id);
CREATE INDEX activity_charges_participant_month_id_idx
  ON activity_charges (participant_id,accounting_month,status,id);
CREATE TRIGGER activity_charges_shape_insert
BEFORE INSERT ON activity_charges WHEN NOT EXISTS (
  SELECT 1 FROM activity_programs AS program
  JOIN activity_participants AS participant ON participant.id=NEW.participant_id
    AND participant.program_id=program.id
  WHERE program.id=NEW.program_id AND program.status='active'
    AND participant.status='active' AND (
    (program.code='tus' AND NEW.lesson_count IS NULL
      AND NEW.group_id IS NOT NULL AND NEW.membership_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM activity_memberships AS membership
        WHERE membership.id=NEW.membership_id AND membership.participant_id=NEW.participant_id
          AND membership.program_id=NEW.program_id AND membership.group_id=NEW.group_id
          AND membership.status='active')
      AND EXISTS (SELECT 1 FROM activity_groups AS activity_group
        WHERE activity_group.id=NEW.group_id AND activity_group.program_id=NEW.program_id
          AND activity_group.status='active'))
    OR (program.code='english' AND NEW.lesson_count IS NOT NULL
      AND ((NEW.group_id IS NULL AND NEW.membership_id IS NULL) OR EXISTS (
        SELECT 1 FROM activity_memberships AS membership
        JOIN activity_groups AS activity_group ON activity_group.id=membership.group_id
        WHERE membership.id=NEW.membership_id AND membership.participant_id=NEW.participant_id
          AND membership.program_id=NEW.program_id AND membership.group_id=NEW.group_id
          AND membership.status='active' AND activity_group.program_id=NEW.program_id
          AND activity_group.status='active')))
  )
) BEGIN SELECT RAISE(ABORT,'activity_charge_shape_mismatch'); END;
CREATE TRIGGER activity_charges_shape_update
BEFORE UPDATE ON activity_charges WHEN NOT EXISTS (
  SELECT 1 FROM activity_programs AS program
  JOIN activity_participants AS participant ON participant.id=NEW.participant_id
    AND participant.program_id=program.id
  WHERE program.id=NEW.program_id AND (
    (program.code='tus' AND NEW.lesson_count IS NULL
      AND NEW.group_id IS NOT NULL AND NEW.membership_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM activity_memberships AS membership
        WHERE membership.id=NEW.membership_id AND membership.participant_id=NEW.participant_id
          AND membership.program_id=NEW.program_id AND membership.group_id=NEW.group_id))
    OR (program.code='english' AND NEW.lesson_count IS NOT NULL
      AND ((NEW.group_id IS NULL AND NEW.membership_id IS NULL) OR EXISTS (
        SELECT 1 FROM activity_memberships AS membership
        WHERE membership.id=NEW.membership_id AND membership.participant_id=NEW.participant_id
          AND membership.program_id=NEW.program_id AND membership.group_id=NEW.group_id)))
  )
) BEGIN SELECT RAISE(ABORT,'activity_charge_shape_mismatch'); END;
CREATE TRIGGER activity_charges_finance_insert
BEFORE INSERT ON activity_charges WHEN NOT EXISTS (
  SELECT 1 FROM finance_entries AS finance
  JOIN activity_programs AS program ON program.id=NEW.program_id
  JOIN specialists AS specialist ON specialist.id=NEW.responsible_specialist_id
  LEFT JOIN finance_entry_voids AS void ON void.finance_entry_id=finance.id
  WHERE finance.id=NEW.finance_entry_id AND finance.kind='income'
    AND finance.record_type=program.code AND finance.accounting_month=NEW.accounting_month
    AND finance.occurred_on IS NEW.occurred_on
    AND finance.specialist_id=NEW.responsible_specialist_id
    AND specialist.status='active' AND void.id IS NULL
) BEGIN SELECT RAISE(ABORT,'activity_charge_finance_mismatch'); END;
CREATE TRIGGER activity_charges_finance_update
BEFORE UPDATE ON activity_charges WHEN NOT EXISTS (
  SELECT 1 FROM finance_entries AS finance
  JOIN activity_programs AS program ON program.id=NEW.program_id
  JOIN specialists AS specialist ON specialist.id=NEW.responsible_specialist_id
  LEFT JOIN finance_entry_voids AS void ON void.finance_entry_id=finance.id
  WHERE finance.id=NEW.finance_entry_id AND finance.kind='income'
    AND finance.record_type=program.code AND finance.accounting_month=NEW.accounting_month
    AND finance.occurred_on IS NEW.occurred_on
    AND finance.specialist_id=NEW.responsible_specialist_id
    AND (NEW.status='inactive' OR (specialist.status='active' AND void.id IS NULL))
) BEGIN SELECT RAISE(ABORT,'activity_charge_finance_mismatch'); END;
CREATE TRIGGER activity_charges_immutable_identity
BEFORE UPDATE ON activity_charges
WHEN OLD.id!=NEW.id OR OLD.participant_id!=NEW.participant_id
  OR OLD.program_id!=NEW.program_id OR OLD.group_id IS NOT NEW.group_id
  OR OLD.membership_id IS NOT NEW.membership_id
  OR OLD.period_precision!=NEW.period_precision OR OLD.occurred_on IS NOT NEW.occurred_on
  OR OLD.accounting_month!=NEW.accounting_month OR OLD.lesson_count IS NOT NEW.lesson_count
  OR OLD.responsible_specialist_id!=NEW.responsible_specialist_id
  OR OLD.finance_entry_id!=NEW.finance_entry_id OR OLD.created_at!=NEW.created_at
BEGIN SELECT RAISE(ABORT,'immutable_activity_charge_provenance'); END;
CREATE TRIGGER activity_charges_version_increment BEFORE UPDATE ON activity_charges
WHEN typeof(NEW.version)!='integer' OR NEW.version!=OLD.version+1
BEGIN SELECT RAISE(ABORT,'invalid_version_increment'); END;
CREATE TRIGGER activity_charges_valid_transition BEFORE UPDATE OF status ON activity_charges
WHEN OLD.status!=NEW.status AND NOT (OLD.status='active' AND NEW.status='inactive')
BEGIN SELECT RAISE(ABORT,'invalid_activity_charge_transition'); END;
CREATE TRIGGER activity_charges_no_delete BEFORE DELETE ON activity_charges
BEGIN SELECT RAISE(ABORT,'no_routine_delete'); END;

CREATE TABLE activity_source_links (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(CAST(id AS BLOB))=length(id) AND length(id) BETWEEN 5 AND 128
    AND substr(id,1,4)='asl_' AND substr(id,5,1) GLOB '[A-Za-z0-9]'
    AND substr(id,5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  source_record_id TEXT NOT NULL REFERENCES workbook_source_records(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  relation TEXT NOT NULL CHECK (
    relation IN ('participant','group','membership_observation','charge')
  ),
  entity_id TEXT NOT NULL CHECK (
    length(entity_id) BETWEEN 5 AND 128
    AND substr(entity_id,5,1) GLOB '[A-Za-z0-9]'
    AND substr(entity_id,5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  created_by_staff_id TEXT NOT NULL REFERENCES staff_users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ',julianday(created_at))
  ),
  UNIQUE (source_record_id,relation)
);
CREATE UNIQUE INDEX activity_source_links_charge_target_idx
  ON activity_source_links (entity_id) WHERE relation='charge';
CREATE INDEX activity_source_links_entity_idx
  ON activity_source_links (relation,entity_id,source_record_id);
CREATE TRIGGER activity_source_links_creator_guard
BEFORE INSERT ON activity_source_links WHEN NOT EXISTS (
  SELECT 1 FROM workbook_source_records AS source
  JOIN workbook_imports AS import ON import.id=source.import_id
  WHERE source.id=NEW.source_record_id AND source.disposition='accepted'
    AND source.record_type IN ('tus','english')
    AND import.created_by_staff_id=NEW.created_by_staff_id
) BEGIN SELECT RAISE(ABORT,'invalid_activity_source_creator'); END;
CREATE TRIGGER activity_source_links_participant_guard
BEFORE INSERT ON activity_source_links WHEN NEW.relation='participant' AND NOT EXISTS (
  SELECT 1 FROM workbook_source_records AS source
  JOIN activity_participants AS participant ON participant.id=NEW.entity_id
  JOIN activity_programs AS program ON program.id=participant.program_id
  WHERE source.id=NEW.source_record_id AND source.record_type=program.code
) BEGIN SELECT RAISE(ABORT,'invalid_activity_participant_source'); END;
CREATE TRIGGER activity_source_links_group_guard
BEFORE INSERT ON activity_source_links WHEN NEW.relation='group' AND NOT EXISTS (
  SELECT 1 FROM workbook_source_records AS source
  JOIN activity_groups AS activity_group ON activity_group.id=NEW.entity_id
  WHERE source.id=NEW.source_record_id AND source.record_type='tus'
    AND activity_group.program_id='apg_tus'
) BEGIN SELECT RAISE(ABORT,'invalid_activity_group_source'); END;
CREATE TRIGGER activity_source_links_membership_guard
BEFORE INSERT ON activity_source_links
WHEN NEW.relation='membership_observation' AND NOT EXISTS (
  SELECT 1 FROM workbook_source_records AS source
  JOIN activity_memberships AS membership ON membership.id=NEW.entity_id
  WHERE source.id=NEW.source_record_id AND source.record_type='tus'
    AND membership.program_id='apg_tus' AND membership.membership_kind='observation'
    AND source.period_precision=membership.period_precision
    AND source.period_month=membership.observed_month
    AND source.occurred_on IS membership.observed_on
) BEGIN SELECT RAISE(ABORT,'invalid_activity_membership_source'); END;
CREATE TRIGGER activity_source_links_charge_graph_guard
BEFORE INSERT ON activity_source_links WHEN NEW.relation='charge' AND NOT EXISTS (
  SELECT 1 FROM activity_charges AS charge
  JOIN activity_programs AS program ON program.id=charge.program_id
  WHERE charge.id=NEW.entity_id
    AND EXISTS (
      SELECT 1 FROM activity_source_links AS participant_link
      WHERE participant_link.source_record_id=NEW.source_record_id
        AND participant_link.relation='participant'
        AND participant_link.entity_id=charge.participant_id
    )
    AND (
      (program.code='english'
        AND NOT EXISTS (SELECT 1 FROM activity_source_links AS extra
          WHERE extra.source_record_id=NEW.source_record_id
            AND extra.relation IN ('group','membership_observation')))
      OR (program.code='tus'
        AND EXISTS (SELECT 1 FROM activity_source_links AS group_link
          WHERE group_link.source_record_id=NEW.source_record_id
            AND group_link.relation='group' AND group_link.entity_id=charge.group_id)
        AND EXISTS (SELECT 1 FROM activity_source_links AS membership_link
          WHERE membership_link.source_record_id=NEW.source_record_id
            AND membership_link.relation='membership_observation'
            AND membership_link.entity_id=charge.membership_id))
    )
) BEGIN SELECT RAISE(ABORT,'activity_charge_source_graph_mismatch'); END;
CREATE TRIGGER activity_source_links_charge_guard
BEFORE INSERT ON activity_source_links WHEN NEW.relation='charge' AND NOT EXISTS (
  SELECT 1 FROM workbook_source_records AS source
  JOIN activity_charges AS charge ON charge.id=NEW.entity_id AND charge.status='active'
  JOIN activity_programs AS program ON program.id=charge.program_id
  JOIN finance_source_links AS finance_link
    ON finance_link.source_record_id=source.id
    AND finance_link.finance_entry_id=charge.finance_entry_id
  JOIN finance_entries AS finance ON finance.id=finance_link.finance_entry_id
  JOIN workbook_resolutions AS resolution ON resolution.import_id=source.import_id
    AND resolution.kind='specialist_mapping'
    AND resolution.source_value_digest=source.specialist_source_digest
    AND resolution.source_value_hmac_version=source.specialist_source_hmac_version
    AND resolution.specialist_id=charge.responsible_specialist_id
  LEFT JOIN finance_entry_voids AS void ON void.finance_entry_id=finance.id
  WHERE source.id=NEW.source_record_id AND source.disposition='accepted'
    AND source.record_type=program.code AND source.accounting_month=charge.accounting_month
    AND source.period_precision=charge.period_precision
    AND source.occurred_on IS charge.occurred_on
    AND finance.kind='income' AND finance.record_type=program.code
    AND finance.accounting_month=charge.accounting_month
    AND finance.occurred_on IS charge.occurred_on
    AND finance.specialist_id=charge.responsible_specialist_id AND void.id IS NULL
) BEGIN SELECT RAISE(ABORT,'invalid_activity_charge_source'); END;
CREATE TRIGGER activity_source_links_no_update BEFORE UPDATE ON activity_source_links
BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER activity_source_links_no_delete BEFORE DELETE ON activity_source_links
BEGIN SELECT RAISE(ABORT,'append_only'); END;

CREATE TRIGGER activity_memberships_imported_provenance_guard
BEFORE UPDATE ON activity_memberships WHEN EXISTS (
  SELECT 1 FROM activity_source_links AS source
  WHERE source.relation='membership_observation' AND source.entity_id=OLD.id
) AND (
  OLD.participant_id!=NEW.participant_id OR OLD.program_id!=NEW.program_id
  OR OLD.group_id!=NEW.group_id OR OLD.membership_kind!=NEW.membership_kind
  OR OLD.period_precision!=NEW.period_precision OR OLD.observed_on IS NOT NEW.observed_on
  OR OLD.observed_month IS NOT NEW.observed_month OR OLD.starts_on IS NOT NEW.starts_on
  OR OLD.ends_on IS NOT NEW.ends_on OR OLD.created_at!=NEW.created_at
) BEGIN SELECT RAISE(ABORT,'immutable_imported_activity_membership'); END;

CREATE TRIGGER finance_entries_activity_reverse_guard
BEFORE UPDATE ON finance_entries WHEN EXISTS (
  SELECT 1 FROM activity_charges AS charge
  JOIN activity_programs AS program ON program.id=charge.program_id
  WHERE charge.finance_entry_id=OLD.id AND charge.status='active' AND (
    NEW.kind!='income' OR NEW.record_type!=program.code
    OR NEW.accounting_month IS NOT charge.accounting_month
    OR NEW.occurred_on IS NOT charge.occurred_on
    OR NEW.specialist_id IS NOT charge.responsible_specialist_id
    OR EXISTS (
      SELECT 1 FROM activity_source_links AS source_link
      JOIN workbook_source_records AS source
        ON source.id=source_link.source_record_id
      WHERE source_link.relation='charge' AND source_link.entity_id=charge.id
        AND source.amount_grosze IS NOT NEW.amount_grosze
    )
  )
) BEGIN SELECT RAISE(ABORT,'linked_activity_finance_drift'); END;

CREATE TRIGGER finance_entry_voids_activity_reverse_guard
BEFORE INSERT ON finance_entry_voids WHEN EXISTS (
  SELECT 1 FROM activity_charges AS charge
  WHERE charge.finance_entry_id=NEW.finance_entry_id AND charge.status='active'
) BEGIN SELECT RAISE(ABORT,'active_activity_charge_finance_void'); END;

CREATE TRIGGER specialists_activity_reverse_guard
BEFORE UPDATE OF status ON specialists
WHEN OLD.status='active' AND NEW.status!='active' AND (
  EXISTS (SELECT 1 FROM activity_group_leaders AS leader
    WHERE leader.specialist_id=OLD.id AND leader.status='active')
) BEGIN SELECT RAISE(ABORT,'specialist_active_activity_dependents'); END;

CREATE TABLE activity_projection_jobs (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(CAST(id AS BLOB))=length(id) AND length(id) BETWEEN 5 AND 128
    AND substr(id,1,4)='apj_' AND substr(id,5,1) GLOB '[A-Za-z0-9]'
    AND substr(id,5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  import_id TEXT NOT NULL UNIQUE REFERENCES workbook_imports(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('ready','running','complete','failed')),
  after_source_record_id TEXT REFERENCES workbook_source_records(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  total_records INTEGER NOT NULL CHECK (
    typeof(total_records)='integer' AND total_records BETWEEN 0 AND 10000
  ),
  processed_records INTEGER NOT NULL CHECK (
    typeof(processed_records)='integer' AND processed_records BETWEEN 0 AND total_records
  ),
  projected_records INTEGER NOT NULL CHECK (
    typeof(projected_records)='integer' AND projected_records BETWEEN 0 AND processed_records
  ),
  created_by_staff_id TEXT NOT NULL REFERENCES staff_users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  correlation_id TEXT NOT NULL CHECK (
    length(CAST(correlation_id AS BLOB))=length(correlation_id)
    AND length(correlation_id) BETWEEN 1 AND 128
    AND substr(correlation_id,1,1) GLOB '[A-Za-z0-9]'
    AND correlation_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  version INTEGER NOT NULL CHECK (typeof(version)='integer' AND version>=1),
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ',julianday(created_at))
  ),
  updated_at TEXT NOT NULL CHECK (
    updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ',julianday(updated_at))
    AND updated_at>=created_at
  ),
  completed_at TEXT CHECK (
    completed_at IS NULL OR (
      completed_at IS strftime('%Y-%m-%dT%H:%M:%fZ',julianday(completed_at))
      AND completed_at>=created_at
    )
  ),
  CHECK ((status='complete')=(completed_at IS NOT NULL)),
  CHECK (projected_records=processed_records),
  CHECK (
    (status='ready' AND after_source_record_id IS NULL
      AND processed_records=0 AND completed_at IS NULL)
    OR (status='running' AND after_source_record_id IS NOT NULL
      AND processed_records>0 AND processed_records<total_records
      AND completed_at IS NULL)
    OR (status='failed' AND completed_at IS NULL
      AND ((processed_records=0 AND after_source_record_id IS NULL)
        OR (processed_records>0 AND after_source_record_id IS NOT NULL)))
    OR (status='complete' AND processed_records=total_records
      AND ((processed_records=0 AND after_source_record_id IS NULL)
        OR (processed_records>0 AND after_source_record_id IS NOT NULL)))
  )
);
CREATE INDEX activity_projection_jobs_status_updated_idx
  ON activity_projection_jobs (status,updated_at,id);
CREATE TRIGGER activity_projection_jobs_readiness_guard
BEFORE INSERT ON activity_projection_jobs WHEN NOT EXISTS (
  SELECT 1 FROM workbook_imports AS import
  JOIN workbook_import_plans AS plan ON plan.import_id=import.id AND plan.workbook_kind='legacy'
  JOIN workbook_materialization_jobs AS finance ON finance.import_id=import.id
    AND finance.status='complete' AND finance.phase='complete'
  WHERE import.id=NEW.import_id AND import.status='complete'
    AND import.created_by_staff_id=NEW.created_by_staff_id
    AND import.correlation_id=NEW.correlation_id
    AND NEW.total_records=(SELECT count(*) FROM workbook_source_records AS source
      WHERE source.import_id=import.id AND source.disposition='accepted'
        AND source.record_type IN ('tus','english'))
) BEGIN SELECT RAISE(ABORT,'activity_projection_not_ready'); END;
CREATE TRIGGER activity_projection_jobs_cursor_insert
BEFORE INSERT ON activity_projection_jobs
WHEN NEW.after_source_record_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workbook_source_records AS source
  WHERE source.id=NEW.after_source_record_id AND source.import_id=NEW.import_id
    AND source.disposition='accepted' AND source.record_type IN ('tus','english')
) BEGIN SELECT RAISE(ABORT,'invalid_activity_projection_cursor'); END;
CREATE TRIGGER activity_projection_jobs_cursor_update
BEFORE UPDATE ON activity_projection_jobs
WHEN NEW.after_source_record_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workbook_source_records AS source
  WHERE source.id=NEW.after_source_record_id AND source.import_id=NEW.import_id
    AND source.disposition='accepted' AND source.record_type IN ('tus','english')
) BEGIN SELECT RAISE(ABORT,'invalid_activity_projection_cursor'); END;
CREATE TRIGGER activity_projection_jobs_cursor_progress_insert
BEFORE INSERT ON activity_projection_jobs WHEN NOT (
  (NEW.processed_records=0 AND NEW.after_source_record_id IS NULL)
  OR (NEW.processed_records>0 AND NEW.after_source_record_id IS NOT NULL
    AND NEW.processed_records=(SELECT count(*) FROM workbook_source_records AS source
      WHERE source.import_id=NEW.import_id AND source.disposition='accepted'
        AND source.record_type IN ('tus','english')
        AND source.id<=NEW.after_source_record_id))
) BEGIN SELECT RAISE(ABORT,'invalid_activity_projection_cursor_progress'); END;
CREATE TRIGGER activity_projection_jobs_cursor_progress_update
BEFORE UPDATE ON activity_projection_jobs WHEN NOT (
  (NEW.processed_records=0 AND NEW.after_source_record_id IS NULL)
  OR (NEW.processed_records>0 AND NEW.after_source_record_id IS NOT NULL
    AND NEW.processed_records=(SELECT count(*) FROM workbook_source_records AS source
      WHERE source.import_id=NEW.import_id AND source.disposition='accepted'
        AND source.record_type IN ('tus','english')
        AND source.id<=NEW.after_source_record_id))
) BEGIN SELECT RAISE(ABORT,'invalid_activity_projection_cursor_progress'); END;
CREATE TRIGGER activity_projection_jobs_immutable_identity
BEFORE UPDATE ON activity_projection_jobs
WHEN OLD.id!=NEW.id OR OLD.import_id!=NEW.import_id
  OR OLD.total_records!=NEW.total_records
  OR OLD.created_by_staff_id!=NEW.created_by_staff_id
  OR OLD.correlation_id!=NEW.correlation_id OR OLD.created_at!=NEW.created_at
BEGIN SELECT RAISE(ABORT,'immutable_activity_projection_job'); END;
CREATE TRIGGER activity_projection_jobs_version_increment
BEFORE UPDATE ON activity_projection_jobs
WHEN typeof(NEW.version)!='integer' OR NEW.version!=OLD.version+1
BEGIN SELECT RAISE(ABORT,'invalid_version_increment'); END;
CREATE TRIGGER activity_projection_jobs_progress_guard
BEFORE UPDATE ON activity_projection_jobs WHEN NEW.processed_records<OLD.processed_records
  OR NEW.projected_records<OLD.projected_records
  OR NEW.projected_records>NEW.processed_records
  OR NEW.processed_records>OLD.processed_records+1
  OR (NEW.processed_records>OLD.processed_records AND NEW.after_source_record_id IS NULL)
  OR (NEW.processed_records=OLD.processed_records
    AND NEW.after_source_record_id IS NOT OLD.after_source_record_id)
  OR (NEW.processed_records>OLD.processed_records
    AND OLD.after_source_record_id IS NOT NULL
    AND NEW.after_source_record_id<=OLD.after_source_record_id)
  OR NEW.updated_at<OLD.updated_at
  OR (NEW.status='complete' AND (
    NEW.processed_records!=NEW.total_records OR NEW.projected_records!=NEW.total_records))
BEGIN SELECT RAISE(ABORT,'invalid_activity_projection_progress'); END;
CREATE TRIGGER activity_projection_jobs_status_guard
BEFORE UPDATE OF status ON activity_projection_jobs WHEN OLD.status!=NEW.status AND NOT (
  (OLD.status='ready' AND NEW.status IN ('running','complete','failed'))
  OR (OLD.status='running' AND NEW.status IN ('running','complete','failed'))
)
BEGIN SELECT RAISE(ABORT,'invalid_activity_projection_status'); END;
CREATE TRIGGER activity_projection_jobs_terminal_guard
BEFORE UPDATE ON activity_projection_jobs WHEN OLD.status IN ('complete','failed')
BEGIN SELECT RAISE(ABORT,'terminal_activity_projection_job'); END;
CREATE TRIGGER activity_projection_jobs_no_delete BEFORE DELETE ON activity_projection_jobs
BEGIN SELECT RAISE(ABORT,'no_routine_delete'); END;

CREATE TABLE activity_request_replays (
  actor_staff_id TEXT NOT NULL REFERENCES staff_users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK (operation IN (
    'activity.projection.continue','activity.group.create','activity.group.edit',
    'activity.participant.create','activity.participant.edit',
    'activity.membership.create','activity.membership.edit',
    'activity.class.create','activity.class.edit','activity.attendance.set'
  )),
  idempotency_key TEXT NOT NULL CHECK (
    length(CAST(idempotency_key AS BLOB))=length(idempotency_key)
    AND length(idempotency_key) BETWEEN 8 AND 128
    AND idempotency_key NOT GLOB '*[^A-Za-z0-9._~-]*'
  ),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash)=43 AND request_hash NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  response_envelope TEXT NOT NULL CHECK (
    json_valid(response_envelope) AND json_type(response_envelope)='object'
  ),
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ',julianday(created_at))
  ),
  PRIMARY KEY (actor_staff_id,operation,idempotency_key)
);
CREATE TRIGGER activity_request_replays_no_update BEFORE UPDATE ON activity_request_replays
BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER activity_request_replays_no_delete BEFORE DELETE ON activity_request_replays
BEGIN SELECT RAISE(ABORT,'append_only'); END;
