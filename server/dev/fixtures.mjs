// Canned answers for the fake AI (local dev + tests). The fake transcript (dev/fake-ai.mjs) is:
// "Welcome everyone. / We decided to ship on Friday. / Priya will update the docs by Thursday."
export default {
  'Take notes on this part': {
    summary: ['The team plans to ship on Friday.'],
    decisions: [{ text: 'Ship on Friday', at: '00:03' }],
    actions: [{ task: 'Update the docs', owner: 'Priya', due: 'Thursday', at: '00:06' }],
    questions: [],
  },
  'Merge these notes': {
    title: 'Release planning',
    overview: 'A short check-in that set the release for Friday.',
    topics: [{ title: 'Release date', at: '00:03' }],
    summary: ['The team plans to ship on Friday.'],
    decisions: [{ text: 'Ship on Friday', at: '00:03' }, { text: '', at: null }],
    actions: [{ task: 'Update the docs', owner: 'Priya', due: 'Thursday', at: '00:06' }, { task: 'Bogus far-away timestamp', owner: null, due: null, at: '59:00' }],
    questions: [],
  },
  'Answer the question using only': 'Priya will update the docs by Thursday [00:06]. Something made up [42:00].',
};
