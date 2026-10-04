var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
import path from 'path';
import crypto from 'crypto';
import fs from 'fs/promises';
import { platform, tmpdir, userInfo } from 'os';
import { spawn, exec } from 'child_process';
import pg from 'pg';
import AsyncExitHook from 'async-exit-hook';
import getBinaries from './binary.js';
const bin = getBinaries();
const { Client } = pg;
/**
 * We have to specify the LC_MESSAGES locale because we rely on inspecting the
 * output of the `initdb` command to see if Postgres is ready. As we're looking
 * for a particular string, we need to force that string into the right locale.
 * @see https://github.com/leinelissen/embedded-postgres/issues/15
 */
const LC_MESSAGES_LOCALE = 'en_US.UTF-8';
// The default configuration options for the class
const defaults = {
    databaseDir: path.join(process.cwd(), 'data', 'db'),
    port: 5432,
    user: 'postgres',
    password: 'password',
    authMethod: 'password',
    persistent: true,
    initdbFlags: [],
    postgresFlags: [],
    createPostgresUser: false,
    onLog: console.log,
    onError: console.error,
};
// Fixes the mode of files that are supposed to be executable
//                        r-xr-xr-x
const BIN_PERMISSIONS = 0b101101101;
const ensureBinIsExecutable = (filePath) => __awaiter(void 0, void 0, void 0, function* () {
    // Only fix the file's mode if it's missing a permission. This is useful
    // when the binaries are in a read-only file system, as a call to chmod
    // (even unnecessary) would cause a crash.
    const stat = yield fs.stat(filePath);
    if ((stat.mode & BIN_PERMISSIONS) !== BIN_PERMISSIONS) {
        yield fs.chmod(filePath, stat.mode | BIN_PERMISSIONS);
    }
});
/**
 * This will track instances of all current initialised clusters. We need this
 * because we want to be able to shutdown any clusters when the script is exited.
 */
const instances = new Set();
/**
 * This class creates an instance from which a single Postgres cluster is
 * managed. Note that many clusters may be created, but they will need seperate
 * data directories in order to be properly lifecycle managed.
 */
class EmbeddedPostgres {
    constructor(options = {}) {
        // Options were previously specified in snake_case rather than
        // camelCase. We still want to accept the old style of options.
        const legacyOptions = {};
        if (options.database_dir) {
            legacyOptions.databaseDir = options.database_dir;
        }
        if (options.auth_method) {
            legacyOptions.authMethod = options.auth_method;
        }
        // Assign default options to options object
        this.options = Object.assign({}, defaults, legacyOptions, options);
        instances.add(this);
        this.isRootUser = userInfo().uid === 0;
    }
    /**
     * This function needs to be called whenever a Postgres cluster first needs
     * to be created. It will populate the data directory with the right
     * settings. If your Postgres cluster is already initialised, you don't need
     * to call this function again.
     */
    initialise() {
        return __awaiter(this, void 0, void 0, function* () {
            const { postgres, initdb } = yield bin;
            // GUARD: Check that a postgres user is available 
            yield this.checkForRootUser();
            // Optionally retrieve the uid and gid
            let permissionIds = yield this.getUidAndGid()
                .catch(() => ({}));
            // GUARD: Check if we need to create users
            if (this.options.createPostgresUser
                && !('uid' in permissionIds)
                && !('gid' in permissionIds)) {
                try {
                    // Create the group and user
                    yield execAsync('groupadd postgres');
                    yield execAsync('useradd -g postgres postgres');
                    // Re-treieve the permission ids now the user exists
                    permissionIds = yield this.getUidAndGid();
                }
                catch (err) {
                    this.options.onError(err);
                    throw new Error('Failed to create and initialize a new user on this system.');
                }
            }
            // GUARD: Ensure that the data directory is owned by the created user
            if (this.options.createPostgresUser) {
                if (!('uid' in permissionIds)) {
                    throw new Error('Failed to retrieve the uid for the newly created user.');
                }
                // Create the data directory and have the user own it, so we
                // don't get any permission errors
                yield fs.mkdir(this.options.databaseDir, { recursive: true });
                yield fs.chown(this.options.databaseDir, permissionIds.uid, permissionIds.gid);
            }
            // Create a file on disk that contains the password in plaintext
            const randomId = crypto.randomBytes(6).readUIntLE(0, 6).toString(36);
            const passwordFile = path.resolve(tmpdir(), `pg-password-${randomId}`);
            yield fs.writeFile(passwordFile, this.options.password + '\n');
            // Make the files executable, in case they are not
            ensureBinIsExecutable(postgres);
            ensureBinIsExecutable(initdb);
            // Initialize the database
            yield new Promise((resolve, reject) => {
                var _a;
                const process = spawn(initdb, [
                    `--pgdata=${this.options.databaseDir}`,
                    `--auth=${this.options.authMethod}`,
                    `--username=${this.options.user}`,
                    `--pwfile=${passwordFile}`,
                    `--lc-messages=${LC_MESSAGES_LOCALE}`,
                    ...this.options.initdbFlags,
                ], Object.assign(Object.assign({}, permissionIds), { env: { LC_MESSAGES: LC_MESSAGES_LOCALE } }));
                // Connect to stderr, as that is where the messages get sent
                (_a = process.stdout) === null || _a === void 0 ? void 0 : _a.on('data', (chunk) => {
                    // Parse the data as a string and log it
                    const message = chunk.toString('utf-8');
                    this.options.onLog(message);
                });
                process.on('exit', (code) => {
                    if (code === 0) {
                        resolve();
                    }
                    else {
                        reject(`Postgres init script exited with code ${code}. Please check the logs for extra info. The data directory might already exist.`);
                    }
                });
            });
            // Clean up the file
            yield fs.unlink(passwordFile);
        });
    }
    /**
     * Start the Postgres cluster with the given configuration. The cluster is
     * started as a seperate process, unmanaged by NodeJS. It is automatically
     * shut down when the script exits.
     */
    start() {
        return __awaiter(this, void 0, void 0, function* () {
            const { postgres } = yield bin;
            // Optionally retrieve the uid and gid
            const permissionIds = yield this.getUidAndGid()
                .catch(() => {
                throw new Error('Postgres cannot run as a root user. embedded-postgres could not find a postgres user to run as instead. Consider using the `createPostgresUser` option.');
            });
            // Make the file executable, in case it is not
            ensureBinIsExecutable(postgres);
            yield new Promise((resolve, reject) => {
                var _a;
                // Spawn a postgres server
                this.process = spawn(postgres, [
                    '-D',
                    this.options.databaseDir,
                    '-p',
                    this.options.port.toString(),
                    ...this.options.postgresFlags,
                ], Object.assign(Object.assign({}, permissionIds), { env: { LC_MESSAGES: LC_MESSAGES_LOCALE } }));
                // Connect to stderr, as that is where the messages get sent
                (_a = this.process.stderr) === null || _a === void 0 ? void 0 : _a.on('data', (chunk) => {
                    // Parse the data as a string and log it
                    const message = chunk.toString('utf-8');
                    this.options.onLog(message);
                    // GUARD: Check for the right message to determine server start
                    if (message.includes('database system is ready to accept connections')) {
                        resolve();
                    }
                });
                // In case the process exits early, the promise is rejected.
                this.process.on('close', () => {
                    reject();
                });
            });
        });
    }
    /**
     * Stop an already started cluster with the given configuration.
     * NOTE: If you have `persisent` set to false, this method WILL DELETE your
     * database files. You will need to call `.initialise()` again after executing
     * this method.
     */
    stop() {
        return __awaiter(this, void 0, void 0, function* () {
            // GUARD: If no database is running, immdiately return the function.
            if (!this.process) {
                return;
            }
            // Kill the existing postgres process
            yield new Promise((resolve) => {
                var _a, _b, _c;
                // Register a handler for when the process finally exists
                (_a = this.process) === null || _a === void 0 ? void 0 : _a.on('exit', resolve);
                // GUARD: Check if we're on Windows, since Windows doesn't support SIGINT
                if (platform() === 'win32') {
                    // GUARD: Double check the pid is there to keep TypeScript happy
                    if (!((_b = this.process) === null || _b === void 0 ? void 0 : _b.pid)) {
                        throw new Error('Could not find process PID');
                    }
                    // Actually kill the process using the Windows taskkill command
                    spawn('taskkill', ['/pid', this.process.pid.toString(), '/f', '/t']);
                }
                else {
                    // If on a sane OS, simply kill using SIGINT
                    (_c = this.process) === null || _c === void 0 ? void 0 : _c.kill('SIGINT');
                }
            });
            // Clean up process
            this.process = undefined;
            // GUARD: Additional work if database is not persistent
            if (this.options.persistent === false) {
                // Delete the data directory
                yield fs.rm(this.options.databaseDir, { recursive: true, force: true });
            }
        });
    }
    /**
     * Create a node-postgres client using the existing cluster configuration.
     *
     * @param database The database that the postgres client should connect to
     * @param host The host that should be pre-filled in the connection options
     * @returns Client
     */
    getPgClient(database = 'postgres', host = 'localhost') {
        // Create client
        const client = new Client({
            user: this.options.user,
            password: this.options.password,
            port: this.options.port,
            host,
            database,
        });
        // Log errors rather than throwing them so that embedded-postgres has
        // enough time to actually shutdown.
        client.on('error', this.options.onError);
        return client;
    }
    /**
     * Create a database with a given name on the cluster
     */
    createDatabase(name) {
        return __awaiter(this, void 0, void 0, function* () {
            // GUARD: Cluster must be running for performing database operations
            if (!this.process) {
                throw new Error('Your cluster must be running before you can create a database');
            }
            // Get client and execute CREATE DATABASE query
            const client = this.getPgClient();
            yield client.connect();
            yield client.query(`CREATE DATABASE ${client.escapeIdentifier(name)}`);
            // Clean up client
            yield client.end();
        });
    }
    /**
     * Drop a database with a given name on the cluster
     */
    dropDatabase(name) {
        return __awaiter(this, void 0, void 0, function* () {
            // GUARD: Cluster must be running for performing database operations
            if (!this.process) {
                throw new Error('Your cluster must be running before you can create a database');
            }
            // Get client and execute DROP DATABASE query
            const client = this.getPgClient();
            yield client.connect();
            yield client.query(`DROP DATABASE ${client.escapeIdentifier(name)}`);
            // Clean up client
            yield client.end();
        });
    }
    /**
     * Warn the user in case they're trying to run this library as a root user
     */
    checkForRootUser() {
        return __awaiter(this, void 0, void 0, function* () {
            // GUARD: Ensure that the user isn't root
            if (!this.isRootUser) {
                return;
            }
            // Attempt to retrieve the uid and gid for the postgres user. This check
            // will throw and error when the postgres user doesn't exist
            try {
                yield this.getUidAndGid();
            }
            catch (err) {
                // GUARD: No user exists, but check that a postgres user should be created
                if (!this.options.createPostgresUser) {
                    throw new Error('You are running this script as root. Postgres does not support running as root. If you wish to continue, configure embedded-postgres to create a Postgres user by setting the `createPostgresUser` option to true.');
                }
            }
        });
    }
    /**
     * Retrieve the uid and gid for a particular user
     */
    getUidAndGid(name = 'postgres') {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.isRootUser) {
                return {};
            }
            const [uid, gid] = yield Promise.all([
                execAsync(`id -u ${name}`).then(Number.parseInt),
                execAsync(`id -g ${name}`).then(Number.parseInt),
            ]);
            return { uid, gid };
        });
    }
}
/**
 * A promisified version of the exec API that either throws on errors or returns
 * the string results from the executed command.
 */
function execAsync(command) {
    return __awaiter(this, void 0, void 0, function* () {
        return new Promise((resolve, reject) => {
            exec(command, (error, stdout) => {
                if (error) {
                    reject(error);
                }
                else {
                    resolve(stdout);
                }
            });
        });
    });
}
/**
 * This script should be called when a Node script is exited, so that we can
 * nicely shutdown all potentially started clusters, and we don't end up with
 * zombie processes.
 */
function gracefulShutdown(done) {
    return __awaiter(this, void 0, void 0, function* () {
        // Loop through all instances, stop them, and await the response
        yield Promise.all([...instances].map((instance) => {
            return instance.stop();
        }));
        // Let NodeJS know we're done
        done();
    });
}
// Register graceful shutdown function
AsyncExitHook(gracefulShutdown);
export default EmbeddedPostgres;
