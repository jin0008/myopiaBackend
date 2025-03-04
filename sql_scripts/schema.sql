--
-- PostgreSQL database cluster dump
--

-- Started on 2025-03-05 00:29:25 KST

SET default_transaction_read_only = off;

SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;

--
-- Roles
--

CREATE ROLE postgres;
ALTER ROLE postgres WITH SUPERUSER INHERIT CREATEROLE CREATEDB LOGIN REPLICATION BYPASSRLS;

--
-- User Configurations
--








--
-- Databases
--

--
-- Database "template1" dump
--

\connect template1

--
-- PostgreSQL database dump
--

-- Dumped from database version 17.4 (Debian 17.4-1.pgdg120+2)
-- Dumped by pg_dump version 17.4 (Ubuntu 17.4-1.pgdg24.04+2)

-- Started on 2025-03-05 00:29:25 KST

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

-- Completed on 2025-03-05 00:29:26 KST

--
-- PostgreSQL database dump complete
--

--
-- Database "app" dump
--

--
-- PostgreSQL database dump
--

-- Dumped from database version 17.4 (Debian 17.4-1.pgdg120+2)
-- Dumped by pg_dump version 17.4 (Ubuntu 17.4-1.pgdg24.04+2)

-- Started on 2025-03-05 00:29:26 KST

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
-- TOC entry 3516 (class 1262 OID 16387)
-- Name: app; Type: DATABASE; Schema: -; Owner: postgres
--

CREATE DATABASE app WITH TEMPLATE = template0 ENCODING = 'UTF8' LOCALE_PROVIDER = libc LOCALE = 'C.UTF-8';


ALTER DATABASE app OWNER TO postgres;

\connect app

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
-- TOC entry 862 (class 1247 OID 16643)
-- Name: ktype; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.ktype AS ENUM (
    'K1',
    'K2'
);


ALTER TYPE public.ktype OWNER TO postgres;

--
-- TOC entry 865 (class 1247 OID 16648)
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
-- TOC entry 217 (class 1259 OID 16653)
-- Name: country; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.country (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    code character varying(2) NOT NULL
);


ALTER TABLE public.country OWNER TO postgres;

--
-- TOC entry 218 (class 1259 OID 16659)
-- Name: ethnicity; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.ethnicity (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(25) NOT NULL
);


ALTER TABLE public.ethnicity OWNER TO postgres;

--
-- TOC entry 219 (class 1259 OID 16663)
-- Name: google_auth; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.google_auth (
    user_id uuid NOT NULL,
    google_identity text NOT NULL
);


ALTER TABLE public.google_auth OWNER TO postgres;

--
-- TOC entry 220 (class 1259 OID 16668)
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
-- TOC entry 221 (class 1259 OID 16673)
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
-- TOC entry 222 (class 1259 OID 16680)
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
-- TOC entry 223 (class 1259 OID 16686)
-- Name: instrument; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.instrument (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(20) NOT NULL
);


ALTER TABLE public.instrument OWNER TO postgres;

--
-- TOC entry 224 (class 1259 OID 16690)
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
-- TOC entry 225 (class 1259 OID 16694)
-- Name: normal_user; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.normal_user (
    user_id uuid NOT NULL
);


ALTER TABLE public.normal_user OWNER TO postgres;

--
-- TOC entry 226 (class 1259 OID 16697)
-- Name: password_auth; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.password_auth (
    user_id uuid NOT NULL,
    username character varying NOT NULL,
    hash character varying NOT NULL
);


ALTER TABLE public.password_auth OWNER TO postgres;

--
-- TOC entry 227 (class 1259 OID 16702)
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
-- TOC entry 228 (class 1259 OID 16708)
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
-- TOC entry 229 (class 1259 OID 16711)
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
-- TOC entry 230 (class 1259 OID 16717)
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
-- TOC entry 231 (class 1259 OID 16723)
-- Name: treatment; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.treatment (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(30) NOT NULL,
    description text
);


ALTER TABLE public.treatment OWNER TO postgres;

--
-- TOC entry 232 (class 1259 OID 16729)
-- Name: user; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public."user" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    is_site_admin boolean DEFAULT false NOT NULL
);


ALTER TABLE public."user" OWNER TO postgres;

--
-- TOC entry 233 (class 1259 OID 16735)
-- Name: user_patient; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.user_patient (
    user_id uuid NOT NULL,
    patient_id uuid NOT NULL
);


ALTER TABLE public.user_patient OWNER TO postgres;

--
-- TOC entry 3294 (class 2606 OID 16739)
-- Name: country country_pk; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.country
    ADD CONSTRAINT country_pk PRIMARY KEY (id);


--
-- TOC entry 3296 (class 2606 OID 16741)
-- Name: country country_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.country
    ADD CONSTRAINT country_unique UNIQUE (name);


--
-- TOC entry 3298 (class 2606 OID 16743)
-- Name: country country_unique_1; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.country
    ADD CONSTRAINT country_unique_1 UNIQUE (code);


--
-- TOC entry 3300 (class 2606 OID 16745)
-- Name: ethnicity ethnicity_pk; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ethnicity
    ADD CONSTRAINT ethnicity_pk PRIMARY KEY (id);


--
-- TOC entry 3302 (class 2606 OID 16747)
-- Name: google_auth google_auth_pk; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.google_auth
    ADD CONSTRAINT google_auth_pk PRIMARY KEY (user_id);


--
-- TOC entry 3304 (class 2606 OID 16749)
-- Name: google_auth google_auth_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.google_auth
    ADD CONSTRAINT google_auth_unique UNIQUE (google_identity);


--
-- TOC entry 3306 (class 2606 OID 16751)
-- Name: growth_data growth_data_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.growth_data
    ADD CONSTRAINT growth_data_unique UNIQUE (age, percentile, sex, ethnicity);


--
-- TOC entry 3308 (class 2606 OID 16753)
-- Name: healthcare_professional healthcare_professional_pk; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.healthcare_professional
    ADD CONSTRAINT healthcare_professional_pk PRIMARY KEY (user_id);


--
-- TOC entry 3310 (class 2606 OID 16755)
-- Name: hospital hospital_pk; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.hospital
    ADD CONSTRAINT hospital_pk PRIMARY KEY (id);


--
-- TOC entry 3312 (class 2606 OID 16757)
-- Name: hospital hospital_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.hospital
    ADD CONSTRAINT hospital_unique UNIQUE (name);


--
-- TOC entry 3314 (class 2606 OID 16759)
-- Name: hospital hospital_unique_1; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.hospital
    ADD CONSTRAINT hospital_unique_1 UNIQUE (code);


--
-- TOC entry 3316 (class 2606 OID 16761)
-- Name: instrument instrument_pk; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.instrument
    ADD CONSTRAINT instrument_pk PRIMARY KEY (id);


--
-- TOC entry 3318 (class 2606 OID 16763)
-- Name: instrument instrument_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.instrument
    ADD CONSTRAINT instrument_unique UNIQUE (name);


--
-- TOC entry 3320 (class 2606 OID 16765)
-- Name: measurement measurement_pk; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.measurement
    ADD CONSTRAINT measurement_pk PRIMARY KEY (id);


--
-- TOC entry 3322 (class 2606 OID 16767)
-- Name: normal_user normal_user_pk; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.normal_user
    ADD CONSTRAINT normal_user_pk PRIMARY KEY (user_id);


--
-- TOC entry 3324 (class 2606 OID 16769)
-- Name: password_auth password_auth_pk; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.password_auth
    ADD CONSTRAINT password_auth_pk PRIMARY KEY (user_id);


--
-- TOC entry 3326 (class 2606 OID 16771)
-- Name: password_auth password_auth_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.password_auth
    ADD CONSTRAINT password_auth_unique UNIQUE (username);


--
-- TOC entry 3330 (class 2606 OID 16773)
-- Name: patient_k patient_k_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.patient_k
    ADD CONSTRAINT patient_k_unique UNIQUE (patient_id, k_type);


--
-- TOC entry 3328 (class 2606 OID 16775)
-- Name: patient patient_pk; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.patient
    ADD CONSTRAINT patient_pk PRIMARY KEY (id);


--
-- TOC entry 3332 (class 2606 OID 16777)
-- Name: patient_treatment patients_treatments_pk; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.patient_treatment
    ADD CONSTRAINT patients_treatments_pk PRIMARY KEY (id);


--
-- TOC entry 3334 (class 2606 OID 16779)
-- Name: session session_pk; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_pk PRIMARY KEY (id);


--
-- TOC entry 3336 (class 2606 OID 16781)
-- Name: session session_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_unique UNIQUE (session_key);


--
-- TOC entry 3338 (class 2606 OID 16783)
-- Name: treatment treatment_pk; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.treatment
    ADD CONSTRAINT treatment_pk PRIMARY KEY (id);


--
-- TOC entry 3340 (class 2606 OID 16785)
-- Name: treatment treatment_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.treatment
    ADD CONSTRAINT treatment_unique UNIQUE (name);


--
-- TOC entry 3344 (class 2606 OID 16787)
-- Name: user_patient user_patient_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_patient
    ADD CONSTRAINT user_patient_unique UNIQUE (user_id, patient_id);


--
-- TOC entry 3342 (class 2606 OID 16789)
-- Name: user user_pk; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_pk PRIMARY KEY (id);


--
-- TOC entry 3345 (class 2606 OID 16790)
-- Name: google_auth google_auth_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.google_auth
    ADD CONSTRAINT google_auth_user_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- TOC entry 3346 (class 2606 OID 16795)
-- Name: healthcare_professional healthcare_professional_country_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.healthcare_professional
    ADD CONSTRAINT healthcare_professional_country_fk FOREIGN KEY (country_id) REFERENCES public.country(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- TOC entry 3347 (class 2606 OID 16800)
-- Name: healthcare_professional healthcare_professional_ethnicity_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.healthcare_professional
    ADD CONSTRAINT healthcare_professional_ethnicity_fk FOREIGN KEY (default_ethnicity_id) REFERENCES public.ethnicity(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- TOC entry 3348 (class 2606 OID 16805)
-- Name: healthcare_professional healthcare_professional_hospital_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.healthcare_professional
    ADD CONSTRAINT healthcare_professional_hospital_fk FOREIGN KEY (hospital_id) REFERENCES public.hospital(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- TOC entry 3349 (class 2606 OID 16810)
-- Name: healthcare_professional healthcare_professional_instrument_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.healthcare_professional
    ADD CONSTRAINT healthcare_professional_instrument_fk FOREIGN KEY (default_instrument_id) REFERENCES public.instrument(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- TOC entry 3350 (class 2606 OID 16815)
-- Name: healthcare_professional healthcare_professional_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.healthcare_professional
    ADD CONSTRAINT healthcare_professional_user_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- TOC entry 3351 (class 2606 OID 16820)
-- Name: hospital hospital_country_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.hospital
    ADD CONSTRAINT hospital_country_fk FOREIGN KEY (country_id) REFERENCES public.country(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- TOC entry 3352 (class 2606 OID 16825)
-- Name: measurement measurement_instrument_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.measurement
    ADD CONSTRAINT measurement_instrument_fk FOREIGN KEY (instrument_id) REFERENCES public.instrument(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- TOC entry 3353 (class 2606 OID 16830)
-- Name: measurement measurement_patient_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.measurement
    ADD CONSTRAINT measurement_patient_fk FOREIGN KEY (patient_id) REFERENCES public.patient(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- TOC entry 3354 (class 2606 OID 16835)
-- Name: measurement measurement_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.measurement
    ADD CONSTRAINT measurement_user_fk FOREIGN KEY (creator_id) REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- TOC entry 3355 (class 2606 OID 16840)
-- Name: normal_user normal_user_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.normal_user
    ADD CONSTRAINT normal_user_user_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- TOC entry 3356 (class 2606 OID 16845)
-- Name: password_auth password_auth_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.password_auth
    ADD CONSTRAINT password_auth_user_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- TOC entry 3357 (class 2606 OID 16850)
-- Name: patient patient_ethnicity_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.patient
    ADD CONSTRAINT patient_ethnicity_fk FOREIGN KEY (ethnicity_id) REFERENCES public.ethnicity(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- TOC entry 3358 (class 2606 OID 16855)
-- Name: patient patient_hospital_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.patient
    ADD CONSTRAINT patient_hospital_fk FOREIGN KEY (hospital_id) REFERENCES public.hospital(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- TOC entry 3360 (class 2606 OID 16860)
-- Name: patient_k patient_k_patient_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.patient_k
    ADD CONSTRAINT patient_k_patient_fk FOREIGN KEY (patient_id) REFERENCES public.patient(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- TOC entry 3361 (class 2606 OID 16865)
-- Name: patient_treatment patient_treatment_patient_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.patient_treatment
    ADD CONSTRAINT patient_treatment_patient_fk FOREIGN KEY (patient_id) REFERENCES public.patient(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- TOC entry 3362 (class 2606 OID 16870)
-- Name: patient_treatment patient_treatment_treatment_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.patient_treatment
    ADD CONSTRAINT patient_treatment_treatment_fk FOREIGN KEY (treatment_id) REFERENCES public.treatment(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- TOC entry 3359 (class 2606 OID 16875)
-- Name: patient patient_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.patient
    ADD CONSTRAINT patient_user_fk FOREIGN KEY (creator_id) REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- TOC entry 3363 (class 2606 OID 16880)
-- Name: session session_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_user_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- TOC entry 3364 (class 2606 OID 16885)
-- Name: user_patient user_patient_patient_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_patient
    ADD CONSTRAINT user_patient_patient_fk FOREIGN KEY (patient_id) REFERENCES public.patient(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- TOC entry 3365 (class 2606 OID 16890)
-- Name: user_patient user_patient_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_patient
    ADD CONSTRAINT user_patient_user_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;


-- Completed on 2025-03-05 00:29:27 KST

--
-- PostgreSQL database dump complete
--

-- Completed on 2025-03-05 00:29:27 KST

--
-- PostgreSQL database cluster dump complete
--

