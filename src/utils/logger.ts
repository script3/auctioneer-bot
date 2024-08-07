import winston from 'winston';
import 'winston-daily-rotate-file';

export const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.DailyRotateFile({
      level: 'info',
      filename: `./data/logs/${process.env.PROCESS_NAME ?? 'main'}-%DATE%.log`,
      datePattern: 'YYYY-MM-DD',
      zippedArchive: false,
      maxSize: '250m',
      maxFiles: '14d',
    }),
  ],
});
