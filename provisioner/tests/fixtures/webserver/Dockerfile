# Tiny known image the Docker-touching tests (M3+) lean on — cheap, deterministic.
# Serves one EXPOSEd port so booter/discovery have a real published port to find.
FROM python:3.12-slim
EXPOSE 8000
CMD ["python", "-m", "http.server", "8000"]
