import sql from 'mssql';

const config = {
  server: process.env.SQL_SERVER,
  database: process.env.SQL_DATABASE,
  port: 1433,

  authentication: {
    type: 'azure-active-directory-default'
  },

  options: {
    encrypt: true,
    trustServerCertificate: false
  }
};

let pool;

export async function getSqlPool() {
  if (!pool) {
    pool = await new sql.ConnectionPool(config).connect();
  }

  return pool;
}

export { sql };