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

CREATE TYPE public.myopia_status AS ENUM (
	'myopia',
	'high_myopia','emmetropia','hyperopia');

CREATE TABLE public.patient_parental_myopia_status (
	id uuid DEFAULT gen_random_uuid() NOT NULL,
	parent_sex public.sex NOT NULL,
	patient_id uuid NOT NULL,
	status public.myopia_status NOT NULL,
	"timestamp" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT patient_parental_myopia_status_pk PRIMARY KEY (id),
	CONSTRAINT patient_parental_myopia_status_patient_fk FOREIGN KEY (patient_id) REFERENCES public.patient(id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TYPE public.activity_duration_category AS ENUM (
	'zero_to_one',
	'one_to_two',
	'two_to_four',
	'four_to_six',
	'six_to_eight',
	'eight_to_infinity'
);

CREATE TABLE public.patient_outdoor_activity (
	id uuid DEFAULT gen_random_uuid() NOT NULL,
	patient_id uuid NOT NULL,
	category public.activity_duration_category NOT NULL,
	"timestamp" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT patient_outdoor_activity_pk PRIMARY KEY (id),
	CONSTRAINT patient_outdoor_activity_patient_fk FOREIGN KEY (patient_id) REFERENCES public.patient(id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE public.patient_nearwork_activity (
	id uuid DEFAULT gen_random_uuid() NOT NULL,
	patient_id uuid NOT NULL,
	category public.activity_duration_category NOT NULL,
	"timestamp" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT patient_nearwork_activity_pk PRIMARY KEY (id),
	CONSTRAINT patient_nearwork_activity_patient_fk FOREIGN KEY (patient_id) REFERENCES public.patient(id) ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO public.treatment ("name") VALUES ('HALT'),('MiSight');

CREATE TABLE public.refractive_error_method (
	id int4 GENERATED ALWAYS AS IDENTITY NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT refractive_error_method_pk PRIMARY KEY (id),
	CONSTRAINT refractive_error_method_unique UNIQUE (name)
);

CREATE TABLE public.refractive_error (
	id uuid DEFAULT gen_random_uuid() NOT NULL,
	method_id int4 NOT NULL,
	od_sph float4 NULL,
	od_cyl float4 NULL,
	os_cyl float4 NULL,
	os_sph float4 NULL,
	"date" date NOT NULL,
	creator_id uuid NULL,
	patient_id uuid NOT NULL,
	CONSTRAINT refractive_error_pk PRIMARY KEY (id),
	CONSTRAINT refractive_error_patient_fk FOREIGN KEY (patient_id) REFERENCES public.patient(id) ON DELETE CASCADE ON UPDATE CASCADE,
	CONSTRAINT refractive_error_refactive_error_method_fk FOREIGN KEY (method_id) REFERENCES public.refractive_error_method(id) ON UPDATE CASCADE,
	CONSTRAINT refractive_error_user_fk FOREIGN KEY (creator_id) REFERENCES public."user"(id) ON DELETE SET NULL ON UPDATE CASCADE
);

ALTER TABLE public.ethnicity ADD CONSTRAINT ethnicity_unique UNIQUE ("name");

ALTER TABLE public.measurement ALTER COLUMN creator_id DROP NOT NULL;

ALTER TABLE public.measurement DROP CONSTRAINT measurement_instrument_fk;
ALTER TABLE public.measurement ADD CONSTRAINT measurement_instrument_fk FOREIGN KEY (instrument_id) REFERENCES public.instrument(id) ON UPDATE CASCADE;
