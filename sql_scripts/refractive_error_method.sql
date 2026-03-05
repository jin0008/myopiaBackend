INSERT INTO public.refractive_error_method ("name")
VALUES ('Autorefraction'),
('Cycloplegic refraction'),
('Manifest refraction') ON CONFLICT (name) DO NOTHING;