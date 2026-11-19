'use strict';

class AutomationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function publicError(error) {
  if (error instanceof AutomationError) return { code: error.code, message: error.message };
  return { code: 'JOB_FAILED', message: 'The video job failed.' };
}

module.exports = { AutomationError, publicError };
