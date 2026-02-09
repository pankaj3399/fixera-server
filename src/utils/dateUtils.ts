/**
 * Shared date utility functions for consistent date handling across the application.
 * Handles MongoDB Extended JSON format ({$date: "..."}), Date instances, and string dates.
 */

type DateInput = string | Date | { $date: string } | null | undefined;

/**
 * Converts various date formats to ISO string.
 * Handles MongoDB Extended JSON format {$date: "..."}, Date instances, and string dates.
 * Validates all inputs to ensure they represent valid dates.
 *
 * @param date - The date value to convert (string, Date, {$date: string}, null, or undefined)
 * @returns ISO string if valid, null otherwise
 */
export const toISOString = (date: DateInput): string | null => {
  if (!date) return null;

  // Handle MongoDB Extended JSON format {$date: "..."}
  if (typeof date === 'object' && date !== null && '$date' in date) {
    const dateStr = date.$date;
    // Validate the $date string
    const parsed = new Date(dateStr);
    return isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  // Handle Date objects
  if (date instanceof Date) {
    return isNaN(date.getTime()) ? null : date.toISOString();
  }

  // Handle string dates - validate by parsing
  if (typeof date === 'string') {
    const parsed = new Date(date);
    return isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  // Fallback: try to convert to Date
  const parsed = new Date(date as unknown as string);
  return isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

/**
 * Extracts a date string from various formats.
 * Similar to toISOString but returns the original string format for string inputs
 * if they are valid dates.
 *
 * @param date - The date value to extract
 * @returns Date string if valid, null otherwise
 */
export const extractDateString = (date: DateInput): string | null => {
  if (!date) return null;

  // Handle MongoDB Extended JSON format {$date: "..."}
  if (typeof date === 'object' && date !== null && '$date' in date) {
    const dateStr = date.$date;
    // Validate the $date string
    const parsed = new Date(dateStr);
    return isNaN(parsed.getTime()) ? null : dateStr;
  }

  // Handle Date objects
  if (date instanceof Date) {
    return isNaN(date.getTime()) ? null : date.toISOString();
  }

  // Handle string dates - validate by parsing, return original if valid
  if (typeof date === 'string') {
    const parsed = new Date(date);
    return isNaN(parsed.getTime()) ? null : date;
  }

  // Fallback: try to convert to Date
  const parsed = new Date(date as unknown as string);
  return isNaN(parsed.getTime()) ? null : parsed.toISOString();
};
