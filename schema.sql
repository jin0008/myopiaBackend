--
-- PostgreSQL database dump
--

\restrict 12l4C4UAjnDXxqoPY3CMjDqYVdeLvUNgZRJzlCrdvdyVvDf1dAijkhhgRpOvkMg

-- Dumped from database version 17.7 (Debian 17.7-3.pgdg12+1)
-- Dumped by pg_dump version 17.7 (Debian 17.7-3.pgdg12+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: ktype; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.ktype AS ENUM (
    'K1',
    'K2'
);


ALTER TYPE public.ktype OWNER TO postgres;

--
-- Name: sex; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.sex AS ENUM (
    'male',
    'female'
);


ALTER TYPE public.sex OWNER TO postgres;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: country; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.country (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    code character varying(2) NOT NULL
);


ALTER TABLE public.country OWNER TO postgres;

--
-- Name: ethnicity; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.ethnicity (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(25) NOT NULL
);


ALTER TABLE public.ethnicity OWNER TO postgres;

--
-- Name: google_auth; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.google_auth (
    user_id uuid NOT NULL,
    google_identity text NOT NULL
);


ALTER TABLE public.google_auth OWNER TO postgres;

--
-- Name: growth_data; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.growth_data (
    age integer NOT NULL,
    percentile integer NOT NULL,
    value real NOT NULL,
    sex public.sex NOT NULL,
    ethnicity character varying NOT NULL
);


ALTER TABLE public.growth_data OWNER TO postgres;

--
-- Name: healthcare_professional; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.healthcare_professional (
    name text NOT NULL,
    country_id uuid NOT NULL,
    approved boolean DEFAULT false NOT NULL,
    hospital_id uuid NOT NULL,
    user_id uuid NOT NULL,
    default_ethnicity_id uuid,
    default_instrument_id uuid,
    is_admin boolean DEFAULT false NOT NULL,
    role character varying NOT NULL
);


ALTER TABLE public.healthcare_professional OWNER TO postgres;

--
-- Name: hospital; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.hospital (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    country_id uuid NOT NULL,
    code character varying NOT NULL
);


ALTER TABLE public.hospital OWNER TO postgres;

--
-- Name: instrument; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.instrument (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(20) NOT NULL
);


ALTER TABLE public.instrument OWNER TO postgres;

--
-- Name: measurement; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.measurement (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    patient_id uuid NOT NULL,
    date date NOT NULL,
    instrument_id uuid NOT NULL,
    creator_id uuid NOT NULL,
    od real,
    os real
);


ALTER TABLE public.measurement OWNER TO postgres;

--
-- Name: normal_user; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.normal_user (
    user_id uuid NOT NULL
);


ALTER TABLE public.normal_user OWNER TO postgres;

--
-- Name: page_views; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.page_views (
    id bigint NOT NULL,
    path text DEFAULT '/'::text NOT NULL,
    ip_hash text,
    user_agent text,
    visited_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public.page_views OWNER TO postgres;

--
-- Name: page_views_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.page_views_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.page_views_id_seq OWNER TO postgres;

--
-- Name: page_views_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.page_views_id_seq OWNED BY public.page_views.id;


--
-- Name: password_auth; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.password_auth (
    user_id uuid NOT NULL,
    username character varying NOT NULL,
    hash character varying NOT NULL
);


ALTER TABLE public.password_auth OWNER TO postgres;

--
-- Name: patient; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.patient (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    hospital_id uuid NOT NULL,
    registration_number text NOT NULL,
    date_of_birth date NOT NULL,
    sex public.sex NOT NULL,
    ethnicity_id uuid NOT NULL,
    creator_id uuid,
    email text
);


ALTER TABLE public.patient OWNER TO postgres;

--
-- Name: patient_k; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.patient_k (
    patient_id uuid NOT NULL,
    k_type public.ktype NOT NULL,
    od real,
    os real
);


ALTER TABLE public.patient_k OWNER TO postgres;

--
-- Name: patient_treatment; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.patient_treatment (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    patient_id uuid NOT NULL,
    treatment_id uuid NOT NULL,
    start_date date NOT NULL,
    end_date date,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT patient_treatment_check CHECK (((end_date >= start_date) OR (end_date IS NULL)))
);


ALTER TABLE public.patient_treatment OWNER TO postgres;

--
-- Name: session; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.session (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_key text NOT NULL,
    user_id uuid NOT NULL,
    valid_until timestamp without time zone NOT NULL
);


ALTER TABLE public.session OWNER TO postgres;

--
-- Name: treatment; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.treatment (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(30) NOT NULL,
    description text
);


ALTER TABLE public.treatment OWNER TO postgres;

--
-- Name: user; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public."user" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    is_site_admin boolean DEFAULT false NOT NULL
);


ALTER TABLE public."user" OWNER TO postgres;

--
-- Name: user_patient; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.user_patient (
    user_id uuid NOT NULL,
    patient_id uuid NOT NULL
);


ALTER TABLE public.user_patient OWNER TO postgres;

--
-- Name: page_views id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.page_views ALTER COLUMN id SET DEFAULT nextval('public.page_views_id_seq'::regclass);


--
-- Name: country country_pk; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.country
    ADD CONSTRAINT country_pk PRIMARY KEY (id);


--
-- Name: country country_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.country
    ADD CONSTRAINT country_unique UNIQUE (name);


--
-- Name: country country_unique_1; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.country
    ADD CONSTRAINT country_unique_1 UNIQUE (code);


--
-- Name: ethnicity ethnicity_pk; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ethnicity
    ADD CONSTRAINT ethnicity_pk PRIMARY KEY (id);


--
-- Name: google_auth google_auth_pk; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.google_auth
    ADD CONSTRAINT google_auth_pk PRIMARY KEY (user_id);


--
-- Name: google_auth google_auth_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.google_auth
    ADD CONSTRAINT google_auth_unique UNIQUE (google_identity);


--
-- Name: growth_data growth_data_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.growth_data
    ADD CONSTRAINT growth_data_unique UNIQUE (age, percentile, sex, ethnicity);


--
-- Name: healthcare_professional healthcare_professional_pk; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.healthcare_professional
    ADD CONSTRAINT healthcare_professional_pk PRIMARY KEY (user_id);


--
-- Name: hospital hospital_pk; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.hospital
    ADD CONSTRAINT hospital_pk PRIMARY KEY (id);


--
-- Name: hospital hospital_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.hospital
    ADD CONSTRAINT hospital_unique UNIQUE (name);


--
-- Name: hospital hospital_unique_1; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.hospital
    ADD CONSTRAINT hospital_unique_1 UNIQUE (code);


--
-- Name: instrument instrument_pk; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.instrument
    ADD CONSTRAINT instrument_pk PRIMARY KEY (id);


--
-- Name: instrument instrument_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.instrument
    ADD CONSTRAINT instrument_unique UNIQUE (name);


--
-- Name: measurement measurement_pk; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.measurement
    ADD CONSTRAINT measurement_pk PRIMARY KEY (id);


--
-- Name: normal_user normal_user_pk; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.normal_user
    ADD CONSTRAINT normal_user_pk PRIMARY KEY (user_id);


--
-- Name: page_views page_views_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.page_views
    ADD CONSTRAINT page_views_pkey PRIMARY KEY (id);


--
-- Name: password_auth password_auth_pk; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.password_auth
    ADD CONSTRAINT password_auth_pk PRIMARY KEY (user_id);


--
-- Name: password_auth password_auth_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.password_auth
    ADD CONSTRAINT password_auth_unique UNIQUE (username);


--
-- Name: patient_k patient_k_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.patient_k
    ADD CONSTRAINT patient_k_unique UNIQUE (patient_id, k_type);


--
-- Name: patient patient_pk; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.patient
    ADD CONSTRAINT patient_pk PRIMARY KEY (id);


--
-- Name: patient_treatment patients_treatments_pk; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.patient_treatment
    ADD CONSTRAINT patients_treatments_pk PRIMARY KEY (id);


--
-- Name: session session_pk; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_pk PRIMARY KEY (id);


--
-- Name: session session_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_unique UNIQUE (session_key);


--
-- Name: treatment treatment_pk; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.treatment
    ADD CONSTRAINT treatment_pk PRIMARY KEY (id);


--
-- Name: treatment treatment_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.treatment
    ADD CONSTRAINT treatment_unique UNIQUE (name);


--
-- Name: user_patient user_patient_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_patient
    ADD CONSTRAINT user_patient_unique UNIQUE (user_id, patient_id);


--
-- Name: user user_pk; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_pk PRIMARY KEY (id);


--
-- Name: page_views_path_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX page_views_path_idx ON public.page_views USING btree (path);


--
-- Name: page_views_visited_at_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX page_views_visited_at_idx ON public.page_views USING btree (visited_at);


--
-- Name: google_auth google_auth_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.google_auth
    ADD CONSTRAINT google_auth_user_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: healthcare_professional healthcare_professional_country_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.healthcare_professional
    ADD CONSTRAINT healthcare_professional_country_fk FOREIGN KEY (country_id) REFERENCES public.country(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: healthcare_professional healthcare_professional_ethnicity_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.healthcare_professional
    ADD CONSTRAINT healthcare_professional_ethnicity_fk FOREIGN KEY (default_ethnicity_id) REFERENCES public.ethnicity(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: healthcare_professional healthcare_professional_hospital_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.healthcare_professional
    ADD CONSTRAINT healthcare_professional_hospital_fk FOREIGN KEY (hospital_id) REFERENCES public.hospital(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: healthcare_professional healthcare_professional_instrument_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.healthcare_professional
    ADD CONSTRAINT healthcare_professional_instrument_fk FOREIGN KEY (default_instrument_id) REFERENCES public.instrument(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: healthcare_professional healthcare_professional_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.healthcare_professional
    ADD CONSTRAINT healthcare_professional_user_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: hospital hospital_country_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.hospital
    ADD CONSTRAINT hospital_country_fk FOREIGN KEY (country_id) REFERENCES public.country(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: measurement measurement_instrument_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.measurement
    ADD CONSTRAINT measurement_instrument_fk FOREIGN KEY (instrument_id) REFERENCES public.instrument(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: measurement measurement_patient_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.measurement
    ADD CONSTRAINT measurement_patient_fk FOREIGN KEY (patient_id) REFERENCES public.patient(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: measurement measurement_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.measurement
    ADD CONSTRAINT measurement_user_fk FOREIGN KEY (creator_id) REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: normal_user normal_user_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.normal_user
    ADD CONSTRAINT normal_user_user_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: password_auth password_auth_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.password_auth
    ADD CONSTRAINT password_auth_user_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: patient patient_ethnicity_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.patient
    ADD CONSTRAINT patient_ethnicity_fk FOREIGN KEY (ethnicity_id) REFERENCES public.ethnicity(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: patient patient_hospital_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.patient
    ADD CONSTRAINT patient_hospital_fk FOREIGN KEY (hospital_id) REFERENCES public.hospital(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: patient_k patient_k_patient_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.patient_k
    ADD CONSTRAINT patient_k_patient_fk FOREIGN KEY (patient_id) REFERENCES public.patient(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: patient_treatment patient_treatment_patient_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.patient_treatment
    ADD CONSTRAINT patient_treatment_patient_fk FOREIGN KEY (patient_id) REFERENCES public.patient(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: patient_treatment patient_treatment_treatment_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.patient_treatment
    ADD CONSTRAINT patient_treatment_treatment_fk FOREIGN KEY (treatment_id) REFERENCES public.treatment(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: patient patient_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.patient
    ADD CONSTRAINT patient_user_fk FOREIGN KEY (creator_id) REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: session session_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_user_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: user_patient user_patient_patient_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_patient
    ADD CONSTRAINT user_patient_patient_fk FOREIGN KEY (patient_id) REFERENCES public.patient(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: user_patient user_patient_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_patient
    ADD CONSTRAINT user_patient_user_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict 12l4C4UAjnDXxqoPY3CMjDqYVdeLvUNgZRJzlCrdvdyVvDf1dAijkhhgRpOvkMg

