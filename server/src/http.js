/** Wrap an async route handler so rejections reach the error middleware. */
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || 'error';
  }
}

export const badRequest = (msg, code) => new HttpError(400, msg, code || 'bad_request');
export const unauthorized = (msg) => new HttpError(401, msg || 'Not authenticated', 'unauthorized');
export const forbidden = (msg) => new HttpError(403, msg, 'forbidden');
export const notFound = (msg) => new HttpError(404, msg || 'Not found', 'not_found');
export const conflict = (msg) => new HttpError(409, msg, 'conflict');

export const ok = (res, data, status = 200) => res.status(status).json(data);
