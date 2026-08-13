/**
 * Shared "what's hot" scoring for community posts and polls.
 *
 * Three signals, weighted by how much effort each one takes: a view is a
 * glance, a like or a vote is a tap, a comment is someone writing something.
 * Views alone would reward clickbait titles; likes alone put a post with two
 * hearts above one people are actually reading.
 *
 * Lives here rather than in one route because posts and polls are ranked in
 * separate endpoints and must stay comparable — a formula copied into two files
 * drifts the first time one of them is tuned.
 */

/** Candidate window. Not a real window so much as a floor — see DECAY_EXPONENT. */
export const POPULAR_WINDOW_DAYS = 7;

export const WEIGHT = { view: 3, like: 4, comment: 7 } as const;

/**
 * Steep on purpose, because "인기" here means what's live today: a day-old item
 * needs roughly 14x the engagement of a fresh one to tie it. The `+2` keeps a
 * brand-new item from dividing by ~0 and scoring infinity.
 */
export const DECAY_EXPONENT = 1.4;

/** Start of the candidate window, relative to now. */
export function popularSince(): Date {
  return new Date(Date.now() - POPULAR_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Views are damped logarithmically. Left linear, a title that pulls clicks but
 * no reaction outranks something people actually engaged with — the
 * 200-views / 0-comments case beats 40-views / 3-comments outright. Log keeps
 * views meaningful while capping how far they alone can carry.
 *
 * `taps` is likes for a post, votes for a poll: both are one tap of agreement.
 */
export function hotScore(
  views: number,
  taps: number,
  comments: number,
  createdAt: Date,
  now: number = Date.now(),
): number {
  const engagement =
    Math.log2(1 + views) * WEIGHT.view + taps * WEIGHT.like + comments * WEIGHT.comment;
  const ageHours = Math.max(0, (now - createdAt.getTime()) / 3_600_000);
  return engagement / Math.pow(ageHours + 2, DECAY_EXPONENT);
}
