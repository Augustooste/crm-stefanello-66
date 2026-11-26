ALTER TABLE public.invites DROP CONSTRAINT invites_role_check;
ALTER TABLE public.invites ADD CONSTRAINT invites_role_check CHECK (role IN ('admin', 'manager', 'finance', 'agent'));