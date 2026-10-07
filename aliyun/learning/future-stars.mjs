// Read the existing learning records without changing completion or access grants.
export function createLearningPeople({ db, courses, progressFor, graduationSummary }) {
  const catalogue = courses.map(({ id, title, parentId }) => ({ id, title, ...(parentId ? { parentId } : {}) }));
  const ids = new Set(catalogue.map(c => c.id));
  const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
  const validate = id => { if (id && !ids.has(id)) fail('课程不存在。'); };
  const statsFor = email => db.prepare("SELECT COALESCE(json_extract(payload,'$.courseId'),'python-basics') AS courseId,COUNT(*) AS submissions,SUM(review_state='done') AS reviewed,MAX(created_at) AS lastSubmittedAt FROM learning_submissions WHERE lower(email)=? GROUP BY courseId").all(email);
  return {
    catalogue,
    participants(courseId) {
      validate(courseId);
      if (!courseId) return null;
      const children = courses.filter(c => c.id === courseId || c.parentId === courseId).map(c => c.id);
      return db.prepare("SELECT DISTINCT lower(email) AS email FROM learning_submissions WHERE COALESCE(json_extract(payload,'$.courseId'),'python-basics') IN (SELECT value FROM json_each(?)) UNION SELECT DISTINCT lower(email) AS email FROM learning_course_drafts WHERE course_id IN (SELECT value FROM json_each(?))").all(JSON.stringify(children), JSON.stringify(children)).map(row => row.email);
    },
    enrich(records) {
      return records.map(row => {
        const email = row.email.toLowerCase(), progress = progressFor(email);
        const drafts = db.prepare('SELECT course_id AS courseId,revision,updated_at AS updatedAt FROM learning_course_drafts WHERE lower(email)=?').all(email);
        const stats = statsFor(email), byCourse = new Map(stats.map(s => [s.courseId, s]));
        for (const draft of drafts) byCourse.set(draft.courseId, { ...(byCourse.get(draft.courseId) || { courseId: draft.courseId, submissions: 0, reviewed: 0, lastSubmittedAt: null }), draft });
        const learning = [...byCourse.values()].map(s => ({ ...s, title: catalogue.find(c => c.id === s.courseId)?.title || s.courseId }));
        return { ...row, progress, graduation: graduationSummary(email), learning };
      });
    },
    records({ email, courseId = '', page = '1' }) {
      validate(courseId);
      if (!/^[^\s@]+@[^\s@]+$/u.test(email || '') || email.length > 254 || !/^[1-9]\d{0,4}$/u.test(page)) fail('学生记录筛选不正确。');
      const children = courses.filter(c => c.id === courseId || c.parentId === courseId).map(c => c.id);
      const where = " WHERE lower(email)=? AND (?='' OR COALESCE(json_extract(payload,'$.courseId'),'python-basics') IN (SELECT value FROM json_each(?)))";
      const args = [email.toLowerCase(), courseId, JSON.stringify(children)];
      const total = db.prepare('SELECT COUNT(*) AS n FROM learning_submissions' + where).get(...args).n;
      const rows = db.prepare("SELECT id,created_at AS createdAt,review_state AS reviewState,review,error,COALESCE(json_extract(payload,'$.courseId'),'python-basics') AS courseId,json_extract(payload,'$.reflection') AS reflection FROM learning_submissions" + where + ' ORDER BY created_at DESC,id LIMIT 20 OFFSET ?').all(...args, (Number(page) - 1) * 20);
      return { records: rows.map(row => ({ ...row, title: catalogue.find(c => c.id === row.courseId)?.title || row.courseId,
        review: row.review ? JSON.parse(row.review) : null })), pagination: { page: Number(page), total, totalPages: Math.ceil(total / 20) } };
    },
  };
}
