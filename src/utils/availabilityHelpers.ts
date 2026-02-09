const DEFAULT_AVAILABILITY: Record<string, any> = {
  monday: { available: true, startTime: "09:00", endTime: "17:00" },
  tuesday: { available: true, startTime: "09:00", endTime: "17:00" },
  wednesday: { available: true, startTime: "09:00", endTime: "17:00" },
  thursday: { available: true, startTime: "09:00", endTime: "17:00" },
  friday: { available: true, startTime: "09:00", endTime: "17:00" },
  saturday: { available: false },
  sunday: { available: false },
};

const hasAnyAvailability = (availability?: Record<string, any>) => {
  if (!availability) return false;
  return Object.values(availability).some(
    (day) => day?.available || day?.startTime || day?.endTime
  );
};

const resolveAvailability = (availability?: Record<string, any>) => {
  if (!availability || !hasAnyAvailability(availability)) {
    return { ...DEFAULT_AVAILABILITY };
  }

  const resolved = { ...DEFAULT_AVAILABILITY } as Record<string, any>;
  Object.entries(availability).forEach(([day, value]) => {
    if (!value) return;
    resolved[day] = { ...resolved[day], ...value };
  });

  return resolved;
};

export { DEFAULT_AVAILABILITY, hasAnyAvailability, resolveAvailability };
