import winston from "winston";
import "winston-daily-rotate-file";

const PROCESS_NAME = `${process.env.NODE_APP_INSTANCE ?? "process"}-${process.env.INSTANCE_NUM ?? process.pid}`;

export const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.DailyRotateFile({
      level: "info",
      filename: `/app/data/logs/${PROCESS_NAME}-%DATE%.log`,
      datePattern: "YYYY-MM-DD-HH",
      zippedArchive: true,
      maxSize: "20m",
      maxFiles: "14d",
    }),
  ],
});
