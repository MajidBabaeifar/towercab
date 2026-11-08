// OBV-9: the owner's steering (goals and direction), read and never written by the observer. Where it is
// kept belongs to the intent that creates it; until that exists this returns nothing, and the observer
// ranks by its evidence alone.

export function readSteering(): string | null {
  return null;
}
