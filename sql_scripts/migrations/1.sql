alter table patient add column "created_at" timestamp not null default now();

CREATE TABLE public.pending_patient_deletion (
	patient_id uuid NOT NULL,
	requested_by uuid NOT NULL,
	request_date timestamp DEFAULT now() NOT NULL,
	CONSTRAINT pending_patient_deletion_pk PRIMARY KEY (patient_id),
	CONSTRAINT pending_patient_deletion_healthcare_professional_fk FOREIGN KEY (requested_by) REFERENCES public.healthcare_professional(user_id) ON DELETE CASCADE ON UPDATE CASCADE,
	CONSTRAINT pending_patient_deletion_patient_fk FOREIGN KEY (patient_id) REFERENCES public.patient(id) ON DELETE CASCADE ON UPDATE CASCADE
);

ALTER TABLE public.patient ALTER COLUMN registration_number DROP NOT NULL;
ALTER TABLE public.patient ALTER COLUMN date_of_birth DROP NOT NULL;
ALTER TABLE public.patient ADD COLUMN encrypted_registration_number bytea NULL;
ALTER TABLE public.patient ADD COLUMN encrypted_date_of_birth bytea NULL;