-- Stage 2: Allow users to claim an unclaimed persona
-- Run this in the Supabase SQL editor

create policy "personas_claim"
  on public.personas for update
  to authenticated
  using (claimed_by is null)
  with check (claimed_by = auth.uid());
