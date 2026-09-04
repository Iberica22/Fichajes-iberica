# Fichajes Ibérica

Aplicación de control horario con validación GPS y exportación profesional a Excel.

## Variables de entorno

- `ADMIN_PIN`: PIN del panel de administración.
- `QR_SECRET`: clave incluida en el QR físico.
- `EMPLOYEES_JSON`: array JSON con `id`, `name` y `pin`.
- `LOCATIONS_JSON`: array JSON con `name`, `latitude`, `longitude` y `allowedRadiusMeters`.
- `DATABASE_PATH`: ruta persistente de SQLite. En Railway se recomienda `/data/fichajes.sqlite` con un volumen montado en `/data`.
- `COMPANY_NAME`: opcional; por defecto `Ibérica Seguridad`.

No deben guardarse PIN ni claves reales en este repositorio.

## Exportaciones

- `/export.xlsx?pin=...`: libro Excel con las hojas `Fichajes` y `Resumen`.
- `/export.csv?pin=...`: CSV compatible con el sistema anterior.

La exportación muestra el centro asociado, coordenadas y un enlace a Google Maps. Los registros históricos calculan el centro más cercano a partir de sus coordenadas cuando no tienen `location_name` guardado.
