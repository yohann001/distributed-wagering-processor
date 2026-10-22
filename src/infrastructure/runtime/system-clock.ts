import { Clock } from '../../shared/application/clock';

export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}
