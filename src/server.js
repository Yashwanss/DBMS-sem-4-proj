const express = require('express');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TOKEN_EXPIRY = process.env.AUTH_TOKEN_EXPIRY || '8h';
const AUTH_SECRET = process.env.AUTH_JWT_SECRET || 'change-this-secret-in-production';
const VALID_ROLES = ['admin', 'coach', 'physio'];

const ID_COLUMN_BY_TABLE = {
  athlete: 'athlete_id',
  coach: 'coach_id',
  training_session: 'session_id',
  injury: 'injury_id',
  recovery_metric: 'recovery_id',
  physiotherapist: 'physio_id',
  physiotherapy_session: 'physio_session_id'
};

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

function loadAuthUsers() {
  const fallback = [
    { username: 'admin', password: 'admin123', role: 'admin', name: 'System Admin' },
    { username: 'coach', password: 'coach123', role: 'coach', name: 'Coach User' },
    { username: 'physio', password: 'physio123', role: 'physio', name: 'Physio User' }
  ];

  if (!process.env.AUTH_USERS_JSON) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(process.env.AUTH_USERS_JSON);
    if (!Array.isArray(parsed) || !parsed.length) return fallback;

    return parsed
      .filter((user) => user && user.username && user.password && VALID_ROLES.includes(String(user.role || '').toLowerCase()))
      .map((user) => ({
        username: String(user.username).trim(),
        password: String(user.password),
        role: String(user.role).toLowerCase(),
        name: String(user.name || user.username).trim()
      }));
  } catch (error) {
    return fallback;
  }
}

const AUTH_USERS = loadAuthUsers().map((user) => ({ ...user, key: user.username.toLowerCase() }));

function ok(res, data) {
  res.json({ success: true, data });
}

function fail(res, error, status = 400) {
  const message = error?.message || String(error);
  res.status(error?.status || status).json({ success: false, error: message });
}

function mapOracleError(error) {
  if (!error || typeof error !== 'object') return error;

  if (error.errorNum === 1) {
    return { status: 409, message: 'Duplicate value detected. Please use unique values where required.' };
  }

  if (error.errorNum === 2291) {
    return { status: 400, message: 'Related record not found. Please check selected IDs.' };
  }

  if (error.errorNum === 2290) {
    return { status: 400, message: 'Input violates validation constraints.' };
  }

  return error;
}

function normalizeRows(rows) {
  return (rows || []).map((row) =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [String(key).toLowerCase(), value]))
  );
}

function asyncRoute(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      fail(res, mapOracleError(error));
    }
  };
}

function getUserFromRequest(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw { status: 401, message: 'Authentication required' };
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    throw { status: 401, message: 'Authentication token missing' };
  }

  try {
    const payload = jwt.verify(token, AUTH_SECRET);
    if (!payload || !VALID_ROLES.includes(String(payload.role || '').toLowerCase())) {
      throw new Error('Invalid token payload');
    }

    return {
      username: String(payload.username || '').trim(),
      role: String(payload.role).toLowerCase(),
      name: String(payload.name || payload.username || '').trim()
    };
  } catch (error) {
    throw { status: 401, message: 'Invalid or expired token' };
  }
}

function withAuth(handler, roles = []) {
  return asyncRoute(async (req, res) => {
    const user = getUserFromRequest(req);
    if (roles.length && !roles.includes(user.role)) {
      throw { status: 403, message: 'Insufficient role permission' };
    }
    req.user = user;
    await handler(req, res);
  });
}

function isMissing(value) {
  return value === undefined || value === null || String(value).trim() === '' || String(value).trim().toLowerCase() === 'undefined';
}

function requiredText(body, field, maxLength = 150) {
  const value = body[field];
  if (isMissing(value)) {
    throw { status: 400, message: `${field} is required` };
  }

  const clean = String(value).trim();
  if (clean.length > maxLength) {
    throw { status: 400, message: `${field} must be <= ${maxLength} characters` };
  }

  return clean;
}

function optionalText(body, field, maxLength = 500) {
  const value = body[field];
  if (isMissing(value)) return null;

  const clean = String(value).trim();
  if (clean.length > maxLength) {
    throw { status: 400, message: `${field} must be <= ${maxLength} characters` };
  }

  return clean;
}

function requiredDate(body, field) {
  const value = requiredText(body, field, 10);
  if (!DATE_RE.test(value)) {
    throw { status: 400, message: `${field} must be in YYYY-MM-DD format` };
  }
  return value;
}

function requiredNumber(body, field, min, max) {
  const value = body[field];
  if (isMissing(value)) {
    throw { status: 400, message: `${field} is required` };
  }

  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw { status: 400, message: `${field} must be a valid number` };
  }

  if (min !== undefined && number < min) {
    throw { status: 400, message: `${field} must be >= ${min}` };
  }

  if (max !== undefined && number > max) {
    throw { status: 400, message: `${field} must be <= ${max}` };
  }

  return number;
}

async function ensureExists(table, idColumn, idValue, label) {
  const rows = await db.query(`SELECT COUNT(*) AS c FROM ${table} WHERE ${idColumn} = :id`, { id: idValue });
  const count = Number(rows[0]?.C || rows[0]?.c || 0);
  if (count === 0) {
    throw { status: 400, message: `${label} does not exist` };
  }
}

async function runInsert(table, payload, res) {
  const fields = Object.keys(payload);
  const values = fields.map((field) => payload[field]);
  const idColumn = ID_COLUMN_BY_TABLE[table];
  const id = await db.insert(table, fields, values, idColumn);
  ok(res, { id });
}

async function getSummary() {
  const [athletes] = await db.query('SELECT COUNT(*) AS c FROM athlete');
  const [coaches] = await db.query('SELECT COUNT(*) AS c FROM coach');
  const [trainingSessions] = await db.query('SELECT COUNT(*) AS c FROM training_session');
  const [injuries] = await db.query('SELECT COUNT(*) AS c FROM injury');
  const [recoveryMetrics] = await db.query('SELECT COUNT(*) AS c FROM recovery_metric');
  const [physiotherapists] = await db.query('SELECT COUNT(*) AS c FROM physiotherapist');
  const [physioSessions] = await db.query('SELECT COUNT(*) AS c FROM physiotherapy_session');
  const [athleteCoachLinks] = await db.query('SELECT COUNT(*) AS c FROM athlete_coach');

  return {
    athletes: Number(athletes.C || athletes.c || 0),
    coaches: Number(coaches.C || coaches.c || 0),
    training_sessions: Number(trainingSessions.C || trainingSessions.c || 0),
    injuries: Number(injuries.C || injuries.c || 0),
    recovery_metrics: Number(recoveryMetrics.C || recoveryMetrics.c || 0),
    physiotherapists: Number(physiotherapists.C || physiotherapists.c || 0),
    physio_sessions: Number(physioSessions.C || physioSessions.c || 0),
    athlete_coach_links: Number(athleteCoachLinks.C || athleteCoachLinks.c || 0)
  };
}

function listHandler(table, orderBy = '1') {
  return async (req, res) => {
    const rows = await db.query(`SELECT * FROM ${table} ORDER BY ${orderBy} DESC`);
    ok(res, normalizeRows(rows));
  };
}

app.get('/api/health', (req, res) => ok(res, { status: 'up' }));

app.post(
  '/api/auth/login',
  asyncRoute(async (req, res) => {
    const username = requiredText(req.body || {}, 'username', 60).toLowerCase();
    const password = requiredText(req.body || {}, 'password', 120);

    const user = AUTH_USERS.find((entry) => entry.key === username);
    if (!user || user.password !== password) {
      throw { status: 401, message: 'Invalid username or password' };
    }

    const token = jwt.sign(
      {
        username: user.username,
        role: user.role,
        name: user.name
      },
      AUTH_SECRET,
      { expiresIn: TOKEN_EXPIRY }
    );

    ok(res, {
      token,
      user: { username: user.username, role: user.role, name: user.name }
    });
  })
);

app.get(
  '/api/auth/me',
  withAuth(async (req, res) => {
    ok(res, { user: req.user });
  })
);

app.get(
  '/api/dashboard/summary',
  withAuth(async (req, res) => {
    const summary = await getSummary();
    ok(res, summary);
  }, VALID_ROLES)
);

app.get(
  '/api/dashboard/insights',
  withAuth(async (req, res) => {
    const [activeInjuries] = await db.query(
      `SELECT COUNT(*) AS c
       FROM injury
       WHERE TO_DATE(injury_date, 'YYYY-MM-DD') >= TRUNC(SYSDATE) - 30`
    );

    const [avgWeeklyLoad] = await db.query(
      `SELECT NVL(AVG(athlete_workload), 0) AS avg_weekly_workload
       FROM (
         SELECT athlete_id_fk, SUM(duration_minutes * load_intensity) AS athlete_workload
         FROM training_session
         WHERE TO_DATE(session_date, 'YYYY-MM-DD') >= TRUNC(SYSDATE) - 7
         GROUP BY athlete_id_fk
       )`
    );

    const [openCareCases] = await db.query(
      `SELECT COUNT(*) AS c
       FROM injury i
       LEFT JOIN physiotherapy_session ps ON ps.injury_id_fk = i.injury_id
       WHERE ps.physio_session_id IS NULL`
    );

    const [recentPhysio] = await db.query(
      `SELECT COUNT(*) AS c
       FROM physiotherapy_session
       WHERE TO_DATE(session_date, 'YYYY-MM-DD') >= TRUNC(SYSDATE) - 7`
    );

    ok(res, {
      active_injuries_30d: Number(activeInjuries.C || activeInjuries.c || 0),
      avg_weekly_workload: Number((avgWeeklyLoad.AVG_WEEKLY_WORKLOAD || avgWeeklyLoad.avg_weekly_workload || 0).toFixed(2)),
      open_care_cases: Number(openCareCases.C || openCareCases.c || 0),
      physio_sessions_7d: Number(recentPhysio.C || recentPhysio.c || 0)
    });
  }, VALID_ROLES)
);

app.get(
  '/api/lookups',
  withAuth(async (req, res) => {
    const [athletes, coaches, injuries, physios] = await Promise.all([
      db.query('SELECT athlete_id, name, sport FROM athlete ORDER BY name'),
      db.query('SELECT coach_id, name, sport FROM coach ORDER BY name'),
      db.query(
        `SELECT i.injury_id, i.injury_type, i.athlete_id_fk, a.name AS athlete_name
         FROM injury i
         JOIN athlete a ON a.athlete_id = i.athlete_id_fk
         ORDER BY TO_DATE(i.injury_date, 'YYYY-MM-DD') DESC`
      ),
      db.query('SELECT physio_id, name, specialization FROM physiotherapist ORDER BY name')
    ]);

    ok(res, {
      athletes: normalizeRows(athletes),
      coaches: normalizeRows(coaches),
      injuries: normalizeRows(injuries),
      physiotherapists: normalizeRows(physios)
    });
  }, VALID_ROLES)
);

app.get(
  '/api/athletes',
  withAuth(async (req, res) => {
    const search = isMissing(req.query.search) ? null : String(req.query.search).trim();
    const sport = isMissing(req.query.sport) ? null : String(req.query.sport).trim();
    const gender = isMissing(req.query.gender) ? null : String(req.query.gender).trim();

    const rows = await db.query(
      `SELECT
         athlete_id,
         name,
         dob,
         gender,
         sport,
         enrollment_date,
         TRUNC(MONTHS_BETWEEN(SYSDATE, TO_DATE(dob, 'YYYY-MM-DD')) / 12) AS age
       FROM athlete
       WHERE (:search IS NULL OR UPPER(name) LIKE '%' || UPPER(:search) || '%' OR UPPER(sport) LIKE '%' || UPPER(:search) || '%')
         AND (:sport IS NULL OR UPPER(sport) = UPPER(:sport))
         AND (:gender IS NULL OR UPPER(gender) = UPPER(:gender))
       ORDER BY athlete_id DESC`,
      { search, sport, gender }
    );

    ok(res, normalizeRows(rows));
  }, VALID_ROLES)
);

app.get(
  '/api/athletes/:athleteId/profile',
  withAuth(async (req, res) => {
    const athleteId = Number(req.params.athleteId);
    if (!Number.isFinite(athleteId) || athleteId <= 0) {
      throw { status: 400, message: 'Invalid athlete ID' };
    }

    const athleteRows = normalizeRows(
      await db.query(
        `SELECT athlete_id, name, dob, gender, sport, enrollment_date,
                TRUNC(MONTHS_BETWEEN(SYSDATE, TO_DATE(dob, 'YYYY-MM-DD')) / 12) AS age
         FROM athlete
         WHERE athlete_id = :athleteId`,
        { athleteId }
      )
    );

    if (!athleteRows.length) {
      throw { status: 404, message: 'Athlete not found' };
    }

    const coaches = normalizeRows(
      await db.query(
        `SELECT c.coach_id, c.name, c.sport, ac.start_date
         FROM athlete_coach ac
         JOIN coach c ON c.coach_id = ac.coach_id_fk
         WHERE ac.athlete_id_fk = :athleteId
         ORDER BY TO_DATE(ac.start_date, 'YYYY-MM-DD') DESC`,
        { athleteId }
      )
    );

    const workload = normalizeRows(
      await db.query(
        `SELECT session_date,
                SUM(duration_minutes) AS total_minutes,
                ROUND(AVG(load_intensity), 2) AS avg_intensity,
                SUM(duration_minutes * load_intensity) AS load_score
         FROM training_session
         WHERE athlete_id_fk = :athleteId
           AND TO_DATE(session_date, 'YYYY-MM-DD') >= TRUNC(SYSDATE) - 60
         GROUP BY session_date
         ORDER BY TO_DATE(session_date, 'YYYY-MM-DD') DESC`,
        { athleteId }
      )
    );

    const recovery = normalizeRows(
      await db.query(
        `SELECT metric_date, fatigue_level, muscle_soreness, sleep_quality
         FROM recovery_metric
         WHERE athlete_id_fk = :athleteId
         ORDER BY TO_DATE(metric_date, 'YYYY-MM-DD') DESC
         FETCH FIRST 20 ROWS ONLY`,
        { athleteId }
      )
    );

    const careRows = normalizeRows(
      await db.query(
        `SELECT
            i.injury_id,
            i.injury_type,
            i.severity,
            i.injury_date,
            i.description,
            ps.physio_session_id,
            ps.session_date AS physio_date,
            ps.treatment_type,
            ps.duration,
            p.physio_id,
            p.name AS physio_name
         FROM injury i
         LEFT JOIN physiotherapy_session ps ON ps.injury_id_fk = i.injury_id
         LEFT JOIN physiotherapist p ON p.physio_id = ps.physio_id_fk
         WHERE i.athlete_id_fk = :athleteId
         ORDER BY TO_DATE(i.injury_date, 'YYYY-MM-DD') DESC, ps.physio_session_id DESC`,
        { athleteId }
      )
    );

    const injuriesMap = new Map();
    for (const row of careRows) {
      const injuryId = row.injury_id;
      if (!injuriesMap.has(injuryId)) {
        injuriesMap.set(injuryId, {
          injury_id: injuryId,
          injury_type: row.injury_type,
          severity: row.severity,
          injury_date: row.injury_date,
          description: row.description,
          physiotherapy_sessions: []
        });
      }

      if (row.physio_session_id) {
        injuriesMap.get(injuryId).physiotherapy_sessions.push({
          physio_session_id: row.physio_session_id,
          session_date: row.physio_date,
          treatment_type: row.treatment_type,
          duration: Number(row.duration || 0),
          physio_id: row.physio_id,
          physio_name: row.physio_name
        });
      }
    }

    ok(res, {
      athlete: athleteRows[0],
      coaches,
      workload,
      recovery,
      injuries: Array.from(injuriesMap.values())
    });
  }, VALID_ROLES)
);

app.get(
  '/api/dashboard/timeline',
  withAuth(async (req, res) => {
    const rows = normalizeRows(
      await db.query(
        `SELECT *
         FROM (
           SELECT TO_DATE(ts.session_date, 'YYYY-MM-DD') AS event_dt,
                  ts.session_date AS event_date,
                  'TRAINING' AS event_type,
                  a.name AS athlete_name,
                  'Load ' || (ts.duration_minutes * ts.load_intensity) || ' (' || ts.duration_minutes || ' min, intensity ' || ts.load_intensity || ')' AS details
           FROM training_session ts
           JOIN athlete a ON a.athlete_id = ts.athlete_id_fk

           UNION ALL

           SELECT TO_DATE(i.injury_date, 'YYYY-MM-DD') AS event_dt,
                  i.injury_date AS event_date,
                  'INJURY' AS event_type,
                  a.name AS athlete_name,
                  i.injury_type || ' [' || i.severity || ']' AS details
           FROM injury i
           JOIN athlete a ON a.athlete_id = i.athlete_id_fk

           UNION ALL

           SELECT TO_DATE(r.metric_date, 'YYYY-MM-DD') AS event_dt,
                  r.metric_date AS event_date,
                  'RECOVERY' AS event_type,
                  a.name AS athlete_name,
                  'Fatigue ' || r.fatigue_level || ', Soreness ' || r.muscle_soreness || ', Sleep ' || r.sleep_quality AS details
           FROM recovery_metric r
           JOIN athlete a ON a.athlete_id = r.athlete_id_fk

           UNION ALL

           SELECT TO_DATE(ps.session_date, 'YYYY-MM-DD') AS event_dt,
                  ps.session_date AS event_date,
                  'PHYSIO' AS event_type,
                  a.name AS athlete_name,
                  ps.treatment_type || ' by ' || p.name AS details
           FROM physiotherapy_session ps
           JOIN injury i ON i.injury_id = ps.injury_id_fk
           JOIN athlete a ON a.athlete_id = i.athlete_id_fk
           JOIN physiotherapist p ON p.physio_id = ps.physio_id_fk
         )
         ORDER BY event_dt DESC
         FETCH FIRST 120 ROWS ONLY`
      )
    );

    ok(res, rows);
  }, VALID_ROLES)
);

app.post(
  '/api/athletes',
  withAuth(async (req, res) => {
    const payload = {
      name: requiredText(req.body, 'name', 100),
      dob: requiredDate(req.body, 'dob'),
      gender: requiredText(req.body, 'gender', 10),
      sport: requiredText(req.body, 'sport', 100),
      enrollment_date: requiredDate(req.body, 'enrollment_date')
    };

    if (!['Male', 'Female', 'Other'].includes(payload.gender)) {
      throw { status: 400, message: 'gender must be Male, Female, or Other' };
    }

    await runInsert('athlete', payload, res);
  }, ['admin'])
);

app.get('/api/coaches', withAuth(listHandler('coach', 'coach_id'), VALID_ROLES));
app.post(
  '/api/coaches',
  withAuth(async (req, res) => {
    const payload = {
      name: requiredText(req.body, 'name', 100),
      sport: requiredText(req.body, 'sport', 100),
      phone: optionalText(req.body, 'phone', 20),
      email: optionalText(req.body, 'email', 150)
    };

    await runInsert('coach', payload, res);
  }, ['admin'])
);

app.get('/api/athlete-coaches', withAuth(listHandler('athlete_coach', 'start_date'), VALID_ROLES));
app.post(
  '/api/athlete-coaches',
  withAuth(async (req, res) => {
    const athleteId = requiredNumber(req.body, 'athlete_id_fk', 1);
    const coachId = requiredNumber(req.body, 'coach_id_fk', 1);

    await ensureExists('athlete', 'athlete_id', athleteId, 'Athlete');
    await ensureExists('coach', 'coach_id', coachId, 'Coach');

    const payload = {
      athlete_id_fk: athleteId,
      coach_id_fk: coachId,
      start_date: requiredDate(req.body, 'start_date')
    };

    await runInsert('athlete_coach', payload, res);
  }, ['admin', 'coach'])
);

app.get('/api/training-sessions', withAuth(listHandler('training_session', 'session_id'), VALID_ROLES));
app.post(
  '/api/training-sessions',
  withAuth(async (req, res) => {
    const athleteId = requiredNumber(req.body, 'athlete_id_fk', 1);
    const coachId = requiredNumber(req.body, 'coach_id_fk', 1);

    await ensureExists('athlete', 'athlete_id', athleteId, 'Athlete');
    await ensureExists('coach', 'coach_id', coachId, 'Coach');

    const payload = {
      session_date: requiredDate(req.body, 'session_date'),
      duration_minutes: requiredNumber(req.body, 'duration_minutes', 1),
      load_intensity: requiredNumber(req.body, 'load_intensity', 1, 10),
      athlete_id_fk: athleteId,
      coach_id_fk: coachId
    };

    await runInsert('training_session', payload, res);
  }, ['admin', 'coach'])
);

app.get('/api/injuries', withAuth(listHandler('injury', 'injury_id'), VALID_ROLES));
app.post(
  '/api/injuries',
  withAuth(async (req, res) => {
    const athleteId = requiredNumber(req.body, 'athlete_id_fk', 1);
    await ensureExists('athlete', 'athlete_id', athleteId, 'Athlete');

    const payload = {
      injury_type: requiredText(req.body, 'injury_type', 120),
      severity: requiredText(req.body, 'severity', 20),
      injury_date: requiredDate(req.body, 'injury_date'),
      description: optionalText(req.body, 'description', 500),
      athlete_id_fk: athleteId
    };

    if (!['Low', 'Moderate', 'High', 'Critical'].includes(payload.severity)) {
      throw { status: 400, message: 'severity must be Low, Moderate, High, or Critical' };
    }

    await runInsert('injury', payload, res);
  }, ['admin', 'coach'])
);

app.get('/api/recovery-metrics', withAuth(listHandler('recovery_metric', 'recovery_id'), VALID_ROLES));
app.post(
  '/api/recovery-metrics',
  withAuth(async (req, res) => {
    const athleteId = requiredNumber(req.body, 'athlete_id_fk', 1);
    await ensureExists('athlete', 'athlete_id', athleteId, 'Athlete');

    const payload = {
      metric_date: requiredDate(req.body, 'metric_date'),
      fatigue_level: requiredNumber(req.body, 'fatigue_level', 1, 10),
      muscle_soreness: requiredNumber(req.body, 'muscle_soreness', 1, 10),
      sleep_quality: requiredNumber(req.body, 'sleep_quality', 1, 10),
      athlete_id_fk: athleteId
    };

    await runInsert('recovery_metric', payload, res);
  }, ['admin', 'coach'])
);

app.get('/api/physiotherapists', withAuth(listHandler('physiotherapist', 'physio_id'), VALID_ROLES));
app.post(
  '/api/physiotherapists',
  withAuth(async (req, res) => {
    const payload = {
      name: requiredText(req.body, 'name', 100),
      specialization: requiredText(req.body, 'specialization', 120),
      phone: optionalText(req.body, 'phone', 20),
      email: optionalText(req.body, 'email', 150)
    };

    await runInsert('physiotherapist', payload, res);
  }, ['admin'])
);

app.get('/api/physio-sessions', withAuth(listHandler('physiotherapy_session', 'physio_session_id'), VALID_ROLES));
app.post(
  '/api/physio-sessions',
  withAuth(async (req, res) => {
    const injuryId = requiredNumber(req.body, 'injury_id_fk', 1);
    const physioId = requiredNumber(req.body, 'physio_id_fk', 1);

    await ensureExists('injury', 'injury_id', injuryId, 'Injury');
    await ensureExists('physiotherapist', 'physio_id', physioId, 'Physiotherapist');

    const payload = {
      session_date: requiredDate(req.body, 'session_date'),
      treatment_type: requiredText(req.body, 'treatment_type', 120),
      duration: requiredNumber(req.body, 'duration', 1),
      injury_id_fk: injuryId,
      physio_id_fk: physioId
    };

    await runInsert('physiotherapy_session', payload, res);
  }, ['admin', 'physio'])
);

app.get(
  '/api/athletes/:athleteId/risk',
  withAuth(async (req, res) => {
    const athleteId = Number(req.params.athleteId);
    if (!Number.isFinite(athleteId) || athleteId <= 0) {
      throw { status: 400, message: 'Invalid athlete ID' };
    }

    const [workloadRow] = await db.query(
      `SELECT NVL(SUM(duration_minutes * load_intensity), 0) AS total_workload
       FROM training_session
       WHERE athlete_id_fk = :athleteId
         AND TO_DATE(session_date, 'YYYY-MM-DD') >= TRUNC(SYSDATE) - 7`,
      { athleteId }
    );

    const [recoveryRow] = await db.query(
      `SELECT
          NVL(AVG(fatigue_level), 0) AS avg_fatigue,
          NVL(AVG(muscle_soreness), 0) AS avg_soreness,
          NVL(AVG(sleep_quality), 0) AS avg_sleep
       FROM recovery_metric
       WHERE athlete_id_fk = :athleteId
         AND TO_DATE(metric_date, 'YYYY-MM-DD') >= TRUNC(SYSDATE) - 7`,
      { athleteId }
    );

    const [activeInjuriesRow] = await db.query(
      `SELECT COUNT(*) AS active_injuries
       FROM injury
       WHERE athlete_id_fk = :athleteId
         AND TO_DATE(injury_date, 'YYYY-MM-DD') >= TRUNC(SYSDATE) - 30`,
      { athleteId }
    );

    const workload = Number(workloadRow.TOTAL_WORKLOAD || workloadRow.total_workload || 0);
    const activeInjuries = Number(activeInjuriesRow.ACTIVE_INJURIES || activeInjuriesRow.active_injuries || 0);
    const avgFatigue = Number(recoveryRow.AVG_FATIGUE || recoveryRow.avg_fatigue || 0);
    const avgSoreness = Number(recoveryRow.AVG_SORENESS || recoveryRow.avg_soreness || 0);
    const avgSleep = Number(recoveryRow.AVG_SLEEP || recoveryRow.avg_sleep || 0);

    const riskScore = Math.max(0, Math.round(workload / 150 + avgFatigue * 4 + avgSoreness * 3 - avgSleep * 3 + activeInjuries * 10));

    let riskLevel = 'Low';
    if (riskScore >= 70) riskLevel = 'High';
    else if (riskScore >= 40) riskLevel = 'Moderate';

    ok(res, {
      athlete_id: athleteId,
      weekly_workload: workload,
      avg_fatigue: Number(avgFatigue.toFixed(2)),
      avg_soreness: Number(avgSoreness.toFixed(2)),
      avg_sleep: Number(avgSleep.toFixed(2)),
      active_injuries_30d: activeInjuries,
      risk_score: riskScore,
      risk_level: riskLevel
    });
  }, VALID_ROLES)
);

async function start() {
  try {
    await db.initDatabase();
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to initialize database:', error.message);
    process.exit(1);
  }
}

start();
