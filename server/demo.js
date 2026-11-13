// Sample meeting for "Try the demo" (written for this app; all names are made up).

const LINES = [
  [0, 'Okay, let’s start. This is the weekly sync for the Pocket Wallet app. Agenda is the UPI bug, the Diwali sale, and the new onboarding.'],
  [9, 'Rahul, you had an update on the payment failures?'],
  [13, 'Yes. About two percent of UPI payments failed last week. It’s a timeout on the bank callback, we wait only five seconds.'],
  [22, 'I tested with thirty seconds on staging and failures dropped to almost zero.'],
  [29, 'Then let’s ship that. We agree to raise the callback timeout to thirty seconds in this Thursday’s release.'],
  [37, 'Rahul, can you own that and also add an alert if failures go above one percent?'],
  [43, 'Sure, I’ll do both by Thursday.'],
  [47, 'Great. Next, the Diwali sale. Sneha?'],
  [51, 'Marketing wants a banner on the home screen from the first of November, and a ten percent cashback for new users.'],
  [60, 'Is the cashback budget approved? Last time finance pushed back.'],
  [65, 'Not yet. I’ll get the final number from finance by Monday.'],
  [70, 'Okay, so the banner is decided, the cashback depends on budget. Arjun, can design do the banner?'],
  [77, 'Yes, I’ll share two banner options on Friday. One question though: do we show it to logged-out users too?'],
  [86, 'Good question. Let’s park that, I need to check with legal about showing offers before login.'],
  [94, 'Last item, onboarding. We lose almost forty percent of users at the KYC step.'],
  [101, 'Most people drop when we ask for the PAN photo. We could let them skip it and finish KYC later.'],
  [109, 'That’s risky for compliance, but let’s try it on ten percent of new users as an experiment.'],
  [116, 'Decision then: skip-for-now on the PAN step, as a ten percent experiment. Priya, can you write the spec?'],
  [124, 'Yes, I’ll write the spec and share it by next Wednesday.'],
  [129, 'Anything else? No? Then quick recap: Rahul on the timeout and alert by Thursday, Sneha on the budget by Monday, Arjun on banners Friday, Priya on the spec next Wednesday.'],
  [141, 'And I’ll follow up with legal on the logged-out banner question. Thanks everyone.'],
];

export function demoMeeting(today = new Date()) {
  const segments = LINES.map(([s, t], i) => ({ s, e: LINES[i + 1]?.[0] ?? s + 6, t }));
  return {
    title: 'Pocket Wallet weekly sync (sample)',
    date: today.toISOString().slice(0, 10),
    durationSec: 147,
    chunks: 2,
    status: 'ready',
    language: 'en',
    parts: [],
    segments,
    minutes: {
      title: 'Pocket Wallet weekly sync',
      overview: 'The team agreed to fix UPI payment failures by raising the bank callback timeout, planned the Diwali sale banner, and decided to test letting new users skip the PAN photo during KYC.',
      topics: [{ title: 'UPI payment failures', at: 9 }, { title: 'Diwali sale', at: 47 }, { title: 'Onboarding drop-off at KYC', at: 94 }],
      summary: [
        'About 2% of UPI payments failed last week because the bank callback timed out after 5 seconds.',
        'A 30-second timeout on staging brought failures close to zero.',
        'Marketing wants a home-screen Diwali banner from 1 November and 10% cashback for new users; the cashback budget is not approved yet.',
        'Around 40% of new users drop off at the KYC step, mostly at the PAN photo.',
      ],
      decisions: [
        { text: 'Raise the UPI callback timeout to 30 seconds in Thursday’s release.', at: 29 },
        { text: 'Show the Diwali banner on the home screen; cashback depends on budget approval.', at: 70 },
        { text: 'Let 10% of new users skip the PAN step and finish KYC later, as an experiment.', at: 116 },
      ],
      actions: [
        { task: 'Raise the callback timeout and add an alert when failures go above 1%', owner: 'Rahul', due: 'Thursday', at: 37, done: false },
        { task: 'Get the final cashback budget from finance', owner: 'Sneha', due: 'Monday', at: 65, done: false },
        { task: 'Share two Diwali banner options', owner: 'Arjun', due: 'Friday', at: 77, done: false },
        { task: 'Write the spec for the skip-PAN experiment', owner: 'Priya', due: 'next Wednesday', at: 124, done: true },
        { task: 'Check with legal about showing offers to logged-out users', owner: 'Meeting host', due: null, at: 141, done: false },
      ],
      questions: [{ text: 'Should the Diwali banner be shown to logged-out users?', at: 77 }],
    },
  };
}
