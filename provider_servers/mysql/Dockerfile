FROM denoland/deno:2.4.5
WORKDIR /app
COPY deno.json main.ts ./
RUN deno cache main.ts
USER root
RUN mkdir -p /data/files && chown -R deno:deno /data/files
USER deno
CMD ["task", "start"]
