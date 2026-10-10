// Read the existing learning records without changing completion or access grants.
function readReview(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return value; }
}
export function createLearningPeople({ db, courses, progressFor, graduationSummary, canonicalId = id => courses.find(course => course.id === id)?.parentId || id, stages = [] }) {
  // Only authenticated requests update presence; admin reads never mark a learner online.
  db.exec('CREATE TABLE IF NOT EXISTS learning_presence(email TEXT PRIMARY KEY COLLATE NOCASE,last_seen INTEGER NOT NULL)');
  const stageById = new Map(stages.flatMap(stage => (stage.courses || []).map(course => [course.id, stage.title])));
  const catalogue = courses.map(({ id, title, parentId }) => ({ id, title, ...(parentId ? { parentId } : {}), stage: stageById.get(parentId || id) || '' }));
  const ids = new Set(catalogue.map(c => c.id));
  const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
  const validate = id => { if (id && !ids.has(id)) fail('课程不存在。'); };
  const statsFor = (email, now) => db.prepare("SELECT COALESCE(json_extract(payload,'$.courseId'),'python-basics') AS courseId,COUNT(*) AS submissions,SUM(review_state='done') AS reviewed,MIN(created_at) AS firstSubmittedAt,MAX(created_at) AS lastSubmittedAt FROM learning_submissions WHERE lower(email)=? AND created_at<=? GROUP BY courseId").all(email, now);
  return {
    catalogue,
    touch(email, now = Date.now()) {
      db.prepare(`INSERT INTO learning_presence(email,last_seen) VALUES(?,?) ON CONFLICT(email) DO UPDATE SET last_seen=excluded.last_seen
        WHERE excluded.last_seen-learning_presence.last_seen>=60000`).run(email.trim().toLowerCase(), now);
    },
    participants(courseId) {
      validate(courseId);
      if (!courseId) return null;
      const children = courses.filter(c => canonicalId(c.id) === canonicalId(courseId)).map(c => c.id);
      return db.prepare("SELECT DISTINCT lower(email) AS email FROM learning_submissions WHERE COALESCE(json_extract(payload,'$.courseId'),'python-basics') IN (SELECT value FROM json_each(?)) UNION SELECT DISTINCT lower(email) AS email FROM learning_course_drafts WHERE course_id IN (SELECT value FROM json_each(?))").all(JSON.stringify(children), JSON.stringify(children)).map(row => row.email);
    },
    enrich(records, { since = 0, now = Date.now(), courseId = '' } = {}) {
      const activity = new Map(db.prepare(`SELECT email,MAX(at) AS at FROM (
        SELECT lower(email) AS email,last_seen AS at FROM learning_presence UNION ALL
        SELECT lower(email),created_at FROM learning_submissions UNION ALL
        SELECT lower(email),updated_at FROM learning_course_drafts UNION ALL
        SELECT lower(email),created_at FROM learning_messages UNION ALL
        SELECT lower(email),created_at FROM learning_git_runs UNION ALL
        SELECT lower(email),created_at FROM learning_graduation_attempts UNION ALL
        SELECT lower(email),created_at FROM learning_patrol_attempts
      ) WHERE at<=? GROUP BY email`).all(now).map(row => [row.email, row.at]));
      return records.map(row => {
        const email = row.email.toLowerCase(), progress = progressFor(email);
        const drafts = db.prepare('SELECT course_id AS courseId,revision,updated_at AS updatedAt FROM learning_course_drafts WHERE lower(email)=? AND updated_at<=?').all(email, now);
        const stats = statsFor(email, now), byCourse = new Map(stats.map(s => [s.courseId, s]));
        for (const draft of drafts) byCourse.set(draft.courseId, { ...(byCourse.get(draft.courseId) || { courseId: draft.courseId, submissions: 0, reviewed: 0, lastSubmittedAt: null }), draft });
        const learning = [...byCourse.values()].map(s => ({ ...s, title: catalogue.find(c => c.id === s.courseId)?.title || s.courseId }));
        const sequence = [...new Set(catalogue.filter(c => !c.parentId).map(c => canonicalId(c.id)))];
        const firstByCourse = new Map();
        for (const stat of stats) {
          const id = canonicalId(stat.courseId);
          if (sequence.includes(id)) firstByCourse.set(id, Math.min(firstByCourse.get(id) ?? Infinity, stat.firstSubmittedAt));
        }
        const submitted = new Set(firstByCourse.keys());
        const exempted = new Set((progress.exemptedCourseIds || []).map(canonicalId).filter(id => sequence.includes(id) && !submitted.has(id)));
        const complete = new Set([...submitted, ...exempted]);
        const started = new Set([...complete, ...drafts.map(draft => canonicalId(draft.courseId)).filter(id => sequence.includes(id))]);
        const recentSubmitted = [...firstByCourse].filter(([id, at]) => at >= since && (!courseId || id === canonicalId(courseId))).length;
        const stageProgress = stages.map(stage => {
          const stageIds = [...new Set((stage.courses || []).map(c => canonicalId(c.id)).filter(id => sequence.includes(id)))];
          return { id: stage.id, title: stage.title, total: stageIds.length, submitted: stageIds.filter(id => submitted.has(id)).length,
            completed: stageIds.filter(id => complete.has(id)).length, exempted: stageIds.filter(id => exempted.has(id)).length };
        }).filter(stage => stage.total);
        const lastCourse = [...learning].sort((a, b) => Math.max(b.lastSubmittedAt || 0, b.draft?.updatedAt || 0) - Math.max(a.lastSubmittedAt || 0, a.draft?.updatedAt || 0))[0];
        const current = catalogue.find(c => c.id === (lastCourse?.courseId || progress.currentCourseId));
        return { ...row, lastActivityAt: Math.max(row.lastActivityAt <= now ? row.lastActivityAt || 0 : 0, activity.get(email) || 0),
          progress, graduation: graduationSummary(email), learning, recentSubmitted, stageProgress,
          currentCourseTitle: current?.title || '暂无课程记录', currentStage: current?.stage || '',
          overall: { total: sequence.length, submitted: submitted.size, completed: complete.size, exempted: exempted.size, started: started.size } };
      });
    },
    records({ email, courseId = '', page = '1' }) {
      validate(courseId);
      if (!/^[^\s@]+@[^\s@]+$/u.test(email || '') || email.length > 254 || !/^[1-9]\d{0,4}$/u.test(page)) fail('学生记录筛选不正确。');
      const children = courses.filter(c => canonicalId(c.id) === canonicalId(courseId)).map(c => c.id);
      const where = " WHERE lower(email)=? AND (?='' OR COALESCE(json_extract(payload,'$.courseId'),'python-basics') IN (SELECT value FROM json_each(?)))";
      const args = [email.toLowerCase(), courseId, JSON.stringify(children)];
      const total = db.prepare('SELECT COUNT(*) AS n FROM learning_submissions' + where).get(...args).n;
      const rows = db.prepare("SELECT id,created_at AS createdAt,review_state AS reviewState,review,error,COALESCE(json_extract(payload,'$.courseId'),'python-basics') AS courseId,json_extract(payload,'$.reflection') AS reflection FROM learning_submissions" + where + ' ORDER BY created_at DESC,id LIMIT 20 OFFSET ?').all(...args, (Number(page) - 1) * 20);
      return { records: rows.map(row => ({ ...row, title: catalogue.find(c => c.id === row.courseId)?.title || row.courseId,
        review: readReview(row.review) })), pagination: { page: Number(page), total, totalPages: Math.ceil(total / 20) } };
    },
  };
}
