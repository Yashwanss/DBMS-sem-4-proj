async function loadSampleData(db, options = {}) {
  const suffix = options.suffix || Date.now().toString();

  await db.withTransaction(async (tx) => {
    const athletes = [
      ['Arjun Mehta', '2004-05-16', 'Male', 'Football', '2024-07-01'],
      ['Nisha Rao', '2003-11-02', 'Female', 'Basketball', '2024-07-01'],
      ['Sara Thomas', '2005-03-21', 'Female', 'Tennis', '2025-01-15'],
      ['Daniel Joseph', '2002-08-13', 'Male', 'Swimming', '2023-08-10'],
      ['Priya Verma', '2004-01-29', 'Female', 'Athletics', '2024-06-01'],
      ['Ayaan Khan', '2005-09-09', 'Male', 'Badminton', '2025-02-10']
    ];

    const athleteIds = [];
    for (const athlete of athletes) {
      const athleteId = await tx.insert('athlete', ['name', 'dob', 'gender', 'sport', 'enrollment_date'], athlete, 'athlete_id');
      athleteIds.push(athleteId);
    }

    const coaches = [
      ['Rahul Nair', 'Football', '9876543210', `rahul.coach.${suffix}@example.com`],
      ['Meena Iyer', 'Basketball', '9876500011', `meena.coach.${suffix}@example.com`],
      ['Vikram Das', 'Racquet Sports', '9876500022', `vikram.coach.${suffix}@example.com`],
      ['Anita Paul', 'Endurance', '9876500033', `anita.coach.${suffix}@example.com`]
    ];

    const coachIds = [];
    for (const coach of coaches) {
      const coachId = await tx.insert('coach', ['name', 'sport', 'phone', 'email'], coach, 'coach_id');
      coachIds.push(coachId);
    }

    const mappings = [
      [0, 0, '2024-07-01'],
      [1, 1, '2024-07-01'],
      [2, 2, '2025-01-15'],
      [3, 3, '2023-08-10'],
      [4, 3, '2024-06-01'],
      [5, 2, '2025-02-10']
    ];

    for (const [athleteIndex, coachIndex, startDate] of mappings) {
      await tx.insert('athlete_coach', ['athlete_id_fk', 'coach_id_fk', 'start_date'], [athleteIds[athleteIndex], coachIds[coachIndex], startDate]);
    }

    const trainingSessions = [
      ['2026-03-28', 90, 7, 0, 0],
      ['2026-03-29', 75, 8, 0, 0],
      ['2026-03-29', 80, 6, 1, 1],
      ['2026-03-30', 70, 7, 2, 2],
      ['2026-03-30', 95, 9, 3, 3],
      ['2026-03-31', 60, 5, 4, 3],
      ['2026-04-01', 85, 8, 5, 2],
      ['2026-04-01', 50, 4, 1, 1],
      ['2026-04-02', 78, 7, 2, 2],
      ['2026-04-02', 88, 8, 4, 3]
    ];

    for (const [date, duration, intensity, athleteIndex, coachIndex] of trainingSessions) {
      await tx.insert(
        'training_session',
        ['session_date', 'duration_minutes', 'load_intensity', 'athlete_id_fk', 'coach_id_fk'],
        [date, duration, intensity, athleteIds[athleteIndex], coachIds[coachIndex]],
        'session_id'
      );
    }

    const injuries = [
      ['Hamstring Strain', 'Moderate', '2026-03-30', 'Left leg strain during sprint', 0],
      ['Ankle Sprain', 'Low', '2026-03-31', 'Mild lateral ankle sprain', 2],
      ['Shoulder Fatigue', 'Moderate', '2026-04-01', 'Overuse during swim sets', 3],
      ['Knee Tendonitis', 'High', '2026-04-02', 'Persistent pain after intervals', 4]
    ];

    const injuryIds = [];
    for (const [type, severity, injuryDate, description, athleteIndex] of injuries) {
      const injuryId = await tx.insert(
        'injury',
        ['injury_type', 'severity', 'injury_date', 'description', 'athlete_id_fk'],
        [type, severity, injuryDate, description, athleteIds[athleteIndex]],
        'injury_id'
      );
      injuryIds.push(injuryId);
    }

    const recoveryMetrics = [
      ['2026-03-30', 7, 6, 5, 0],
      ['2026-03-31', 5, 4, 7, 0],
      ['2026-03-31', 4, 3, 8, 1],
      ['2026-03-31', 6, 5, 6, 2],
      ['2026-04-01', 6, 5, 7, 3],
      ['2026-04-01', 8, 7, 5, 4],
      ['2026-04-02', 5, 4, 8, 5],
      ['2026-04-02', 4, 3, 8, 2]
    ];

    for (const [metricDate, fatigue, soreness, sleep, athleteIndex] of recoveryMetrics) {
      await tx.insert(
        'recovery_metric',
        ['metric_date', 'fatigue_level', 'muscle_soreness', 'sleep_quality', 'athlete_id_fk'],
        [metricDate, fatigue, soreness, sleep, athleteIds[athleteIndex]],
        'recovery_id'
      );
    }

    const physios = [
      ['Dr. Kavya Singh', 'Sports Rehabilitation', '9000011111', `kavya.physio.${suffix}@example.com`],
      ['Dr. Rohan Pillai', 'Musculoskeletal Therapy', '9000012222', `rohan.physio.${suffix}@example.com`],
      ['Dr. Leena Das', 'Performance Recovery', '9000013333', `leena.physio.${suffix}@example.com`]
    ];

    const physioIds = [];
    for (const physio of physios) {
      const physioId = await tx.insert('physiotherapist', ['name', 'specialization', 'phone', 'email'], physio, 'physio_id');
      physioIds.push(physioId);
    }

    const physioSessions = [
      ['2026-03-31', 'Manual Therapy', 45, 0, 0],
      ['2026-04-01', 'Mobility and Taping', 35, 1, 1],
      ['2026-04-02', 'Therapeutic Ultrasound', 40, 2, 2],
      ['2026-04-03', 'Strength Reconditioning', 50, 3, 0]
    ];

    for (const [sessionDate, treatmentType, duration, injuryIndex, physioIndex] of physioSessions) {
      await tx.insert(
        'physiotherapy_session',
        ['session_date', 'treatment_type', 'duration', 'injury_id_fk', 'physio_id_fk'],
        [sessionDate, treatmentType, duration, injuryIds[injuryIndex], physioIds[physioIndex]],
        'physio_session_id'
      );
    }
  });
}

module.exports = { loadSampleData };