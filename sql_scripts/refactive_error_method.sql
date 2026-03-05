INSERT INTO public.refactive_error_method ("name") VALUES ('Autorefraction'),('Cycloplegic refraction'),('Manifest refraction')
ON CONFLICT (name) DO NOTHING;