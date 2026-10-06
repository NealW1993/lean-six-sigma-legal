FROM denoland/deno:2.4.5
WORKDIR /app/mysql
COPY mysql/deno.json mysql/deno.lock mysql/main.ts ./
COPY shared/ ../shared/
RUN deno cache main.ts
USER root
RUN mkdir -p /data/files && chown -R deno:deno /data/files
USER deno
CMD ["task", "start"]
