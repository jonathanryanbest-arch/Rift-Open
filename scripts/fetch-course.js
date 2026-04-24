#!/usr/bin/env node
// One-off import: fetch course hole data from golfcourseapi.com and
// normalize to data/course.json. Run once, commit the result.
//
// Usage:
//   GOLF_COURSE_API_KEY=xxxxx node scripts/fetch-course.js "Arrowhead Colorado"
//   GOLF_COURSE_API_KEY=xxxxx COURSE_ID=19 node scripts/fetch-course.js
//   GOLF_COURSE_API_KEY=xxxxx TEE=blue node scripts/fetch-course.js "Arrowhead Colorado"

const fs = require('fs');
const path = require('path');

const API = 'https://api.golfcourseapi.com';
const key = process.env.GOLF_COURSE_API_KEY;
if (!key) {
  console.error('Missing GOLF_COURSE_API_KEY env var');
  process.exit(1);
}

async function apiGet(url) {
  const res = await fetch(url, { headers: { 'Authorization': 'Key ' + key } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} on ${url}\n${body}`);
  }
  return res.json();
}

function pickTee(course, preferred) {
  const tees = (course.tees && course.tees.male) || [];
  if (!tees.length) throw new Error('Course has no male tees');
  if (preferred) {
    const match = tees.find(t => (t.tee_name || '').toLowerCase() === preferred.toLowerCase());
    if (match) return match;
  }
  return tees[0];
}

function normalize(course, tee) {
  const holes = (tee.holes || []).map((h, i) => ({
    num: i + 1,
    par: h.par,
    yardage: h.yardage,
    handicap: h.handicap
  }));
  const totalYards = holes.reduce((s, h) => s + (h.yardage || 0), 0);
  const totalPar = holes.reduce((s, h) => s + (h.par || 0), 0);
  return {
    id: course.id,
    clubName: course.club_name,
    courseName: course.course_name,
    location: course.location && {
      address: course.location.address,
      city: course.location.city,
      state: course.location.state,
      country: course.location.country
    },
    tee: {
      name: tee.tee_name,
      rating: tee.course_rating,
      slope: tee.slope_rating,
      totalYards
    },
    holes,
    totalPar,
    fetchedAt: Date.now()
  };
}

(async () => {
  try {
    let courseId = process.env.COURSE_ID;
    if (!courseId) {
      const query = process.argv.slice(2).join(' ').trim();
      if (!query) {
        console.error('Provide a search term or COURSE_ID env var');
        process.exit(1);
      }
      console.log('Searching:', query);
      const search = await apiGet(`${API}/v1/search?search_query=${encodeURIComponent(query)}`);
      const first = (search.courses || [])[0];
      if (!first) {
        console.error('No courses matched:', query);
        process.exit(1);
      }
      courseId = first.id;
      console.log('Matched:', first.club_name, '·', first.course_name, '(id=' + first.id + ')');
    }
    const detail = await apiGet(`${API}/v1/courses/${courseId}`);
    // API sometimes wraps in { course: {...} }, sometimes returns the course directly.
    const course = detail.course || detail;
    const tee = pickTee(course, process.env.TEE);
    const normalized = normalize(course, tee);

    const outDir = path.resolve(__dirname, '..', 'data');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, 'course.json');
    fs.writeFileSync(outPath, JSON.stringify(normalized, null, 2));
    console.log('Wrote', outPath);
    console.log('  Club:', normalized.clubName);
    console.log('  Course:', normalized.courseName);
    console.log('  Tee:', normalized.tee.name, `${normalized.tee.rating}/${normalized.tee.slope}`, normalized.tee.totalYards + 'yd');
    console.log('  Par:', normalized.totalPar);
    console.log('  Holes:', normalized.holes.length);
  } catch (e) {
    console.error('Import failed:', e.message || e);
    process.exit(1);
  }
})();
