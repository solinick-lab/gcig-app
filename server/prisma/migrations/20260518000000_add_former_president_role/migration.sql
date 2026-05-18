-- Add the honorific "FormerPresident" value to the Role enum.
-- Used only as an extraRoles badge for a President who has stepped down
-- (their primary role becomes JuniorAnalyst). Additive and append-only:
-- existing rows and enum value ordinals are unaffected. No backfill.
ALTER TYPE "Role" ADD VALUE 'FormerPresident';
