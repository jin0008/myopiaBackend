/**
 * Axial length alert threshold (mm). Used as the fallback when no age/sex
 * specific row exists in `axial_length_threshold`. Measurements with od/os above
 * `max` trigger an email notification to the hospital's admins.
 */
export const AXIAL_LENGTH_ALERT = { max: 26.0 };

/**
 * Axial length "query" alert criteria (matches the input-time popup on the
 * frontend). A value outside the normal range, or changing too fast vs. the
 * previous measurement, triggers an alert. Clinical placeholder values to be
 * confirmed: 20~30mm 정상범위, 직전대비 0.30mm 이상 감소, 증가속도 1.0mm/year.
 */
export const AXIAL_QUERY = {
  /** At/below this or at/above `maxNormal` is flagged (mm). */
  minNormal: 20.0,
  maxNormal: 30.0,
  /** Flag if it dropped at least this much vs. the previous record (mm). */
  decreaseMm: 0.3,
  /** Flag if the annualised increase reaches this (mm/year). */
  increaseMmPerYear: 1.0,
};

/**
 * Myopia progression-rate alert thresholds. When the change between a patient's
 * two most recent records, annualised, meets or exceeds these values, an alert
 * is sent. Placeholder values per the estimate (안축장 0.3mm/년, SE 0.75D/년);
 * to be replaced with the hospital's clinical criteria once provided.
 */
export const PROGRESSION_ALERT = {
  /** Axial length elongation, mm per year. */
  axialLengthMmPerYear: 0.3,
  /** Spherical-equivalent myopic shift, dioptres per year (magnitude). */
  seDioptersPerYear: 0.75,
};

/**
 * Absolute spherical-equivalent threshold (dioptres). An SE at or below this
 * (i.e. more myopic) is flagged as high myopia. Placeholder pending clinical
 * confirmation.
 */
export const SE_ALERT = { min: -6.0 };
