/**
 * path-utils.js
 * Utility functions for file path operations in Task Master
 *
 * This module provides robust path resolution for both:
 * 1. PACKAGE PATH: Where task-master code is installed
 *    (global node_modules OR local ./node_modules/task-master OR direct from repo)
 * 2. PROJECT PATH: Where user's tasks.json resides (typically user's project root)
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import os from 'os';

// Store last found project root to improve performance on subsequent calls (primarily for CLI)
export let lastFoundProjectRoot = null;

// Project marker files that indicate a potential project root
export const PROJECT_MARKERS = [
	// Task Master specific
	'tasks.json',
	'tasks/tasks.json',

	// Common version control
	'.git',
	'.svn',

	// Common package files
	'package.json',
	'pyproject.toml',
	'Gemfile',
	'go.mod',
	'Cargo.toml',

	// Common IDE/editor folders
	'.cursor',
	'.vscode',
	'.idea',

	// Common dependency directories (check if directory)
	'node_modules',
	'venv',
	'.venv',

	// Common config files
	'.env',
	'.eslintrc',
	'tsconfig.json',
	'babel.config.js',
	'jest.config.js',
	'webpack.config.js',

	// Common CI/CD files
	'.github/workflows',
	'.gitlab-ci.yml',
	'.circleci/config.yml'
];

/**
 * Gets the path to the task-master package installation directory
 * NOTE: This might become unnecessary if CLI fallback in MCP utils is removed.
 * @returns {string} - Absolute path to the package installation directory
 */
export function getPackagePath() {
	// When running from source, __dirname is the directory containing this file
	// When running from npm, we need to find the package root
	const thisFilePath = fileURLToPath(import.meta.url);
	const thisFileDir = path.dirname(thisFilePath);

	// Navigate from core/utils up to the package root
	// In dev: /path/to/task-master/mcp-server/src/core/utils -> /path/to/task-master
	// In npm: /path/to/node_modules/task-master/mcp-server/src/core/utils -> /path/to/node_modules/task-master
	return path.resolve(thisFileDir, '../../../../');
}

/**
 * Normalizes a potentially URL-encoded Windows path to a standard format
 * @param {string} inputPath - The path to normalize
 * @returns {string} - Normalized path
 */
function normalizeWindowsPath(inputPath) {
	if (!inputPath) return inputPath;

	// Handle URL-encoded drive letters (e.g., /d%3A/ -> D:/)
	let normalizedPath = inputPath.replace(/^\/([a-zA-Z])%3A\//, '$1:/');

	// Convert remaining forward slashes to the OS-specific separator
	normalizedPath = path.normalize(normalizedPath);

	return normalizedPath;
}

/**
 * Finds the absolute path to the tasks.json file based on project root and arguments.
 * @param {Object} args - Command arguments, potentially including 'projectRoot' and 'file'.
 * @param {Object} log - Logger object.
 * @returns {string} - Absolute path to the tasks.json file.
 * @throws {Error} - If tasks.json cannot be found.
 */
export function findTasksJsonPath(args, log) {
	// PRECEDENCE ORDER for finding tasks.json:
	// 1. Explicitly provided `projectRoot` in args (Highest priority, expected in MCP context)
	// 2. Previously found/cached `lastFoundProjectRoot` (primarily for CLI performance)
	// 3. Search upwards from current working directory (`process.cwd()`) - CLI usage

	// 1. If project root is explicitly provided (e.g., from MCP session), use it directly
	if (args.projectRoot) {
		const projectRoot = normalizeWindowsPath(args.projectRoot);
		log.info(`Using explicitly provided project root (normalized): ${projectRoot}`);
		try {
			// This will throw if tasks.json isn't found within this root
			return findTasksJsonInDirectory(projectRoot, args.file, log);
		} catch (error) {
			// Include debug info in error
			const debugInfo = {
				originalProjectRoot: args.projectRoot,
				normalizedProjectRoot: projectRoot,
				currentDir: process.cwd(),
				serverDir: path.dirname(process.argv[1]),
				possibleProjectRoot: path.resolve(
					path.dirname(process.argv[1]),
					'../..'
				),
				lastFoundProjectRoot,
				searchedPaths: error.message
			};

			error.message = `Tasks file not found in any of the expected locations relative to project root "${projectRoot}" (from session).\nDebug Info: ${JSON.stringify(debugInfo, null, 2)}`;
			throw error;
		}
	}

	// --- Fallback logic primarily for CLI or when projectRoot isn't passed ---

	// 2. If we have a last known project root that worked, try it first
	if (lastFoundProjectRoot) {
		log.info(`Trying last known project root: ${lastFoundProjectRoot}`);
		try {
			// Use the cached root
			const tasksPath = findTasksJsonInDirectory(
				lastFoundProjectRoot,
				args.file,
				log
			);
			return tasksPath; // Return if found in cached root
		} catch (error) {
			log.info(
				`Task file not found in last known project root, continuing search.`
			);
			// Continue with search if not found in cache
		}
	}

	// 3. Start search from current directory (most common CLI scenario)
	const startDir = process.cwd();
	log.info(
		`Searching for tasks.json starting from current directory: ${startDir}`
	);

	// Try to find tasks.json by walking up the directory tree from cwd
	try {
		// This will throw if not found in the CWD tree
		return findTasksJsonWithParentSearch(startDir, args.file, log);
	} catch (error) {
		// If all attempts fail, augment and throw the original error from CWD search
		error.message = `${error.message}\n\nPossible solutions:\n1. Run the command from your project directory containing tasks.json\n2. Use --project-root=/path/to/project to specify the project location (if using CLI)\n3. Ensure the project root is correctly passed from the client (if using MCP)\n\nCurrent working directory: ${startDir}\nLast known project root: ${lastFoundProjectRoot}\nProject root from args: ${args.projectRoot}`;
		throw error;
	}
}

/**
 * Check if a directory contains any project marker files or directories
 * @param {string} dirPath - Directory to check
 * @returns {boolean} - True if the directory contains any project markers
 */
function hasProjectMarkers(dirPath) {
	return PROJECT_MARKERS.some((marker) => {
		const markerPath = path.join(dirPath, marker);
		// Check if the marker exists as either a file or directory
		return fs.existsSync(markerPath);
	});
}

/**
 * Search for tasks.json in a specific directory
 * @param {string} dirPath - Directory to search in
 * @param {string} explicitFilePath - Optional explicit file path relative to dirPath
 * @param {Object} log - Logger object
 * @returns {string} - Absolute path to tasks.json
 * @throws {Error} - If tasks.json cannot be found
 */
function findTasksJsonInDirectory(dirPath, explicitFilePath, log) {
	const possiblePaths = [];

	// 1. If a file is explicitly provided relative to dirPath
	if (explicitFilePath) {
		possiblePaths.push(path.resolve(dirPath, explicitFilePath));
	}

	// 2. Check the standard locations relative to dirPath
	possiblePaths.push(
		path.join(dirPath, 'tasks.json'),
		path.join(dirPath, 'tasks', 'tasks.json')
	);

	log.info(`Checking potential task file paths: ${possiblePaths.join(', ')}`);

	// Find the first existing path
	for (const p of possiblePaths) {
		log.info(`Checking if exists: ${p}`);
		const exists = fs.existsSync(p);
		log.info(`Path ${p} exists: ${exists}`);

		if (exists) {
			log.info(`Found tasks file at: ${p}`);
			// Store the project root for future use
			lastFoundProjectRoot = dirPath;
			return p;
		}
	}

	// If no file was found, throw an error
	const error = new Error(
		`Tasks file not found in any of the expected locations relative to ${dirPath}: ${possiblePaths.join(', ')}`
	);
	error.code = 'TASKS_FILE_NOT_FOUND';
	throw error;
}

/**
 * Recursively search for tasks.json in the given directory and parent directories
 * Also looks for project markers to identify potential project roots
 * @param {string} startDir - Directory to start searching from
 * @param {string} explicitFilePath - Optional explicit file path
 * @param {Object} log - Logger object
 * @returns {string} - Absolute path to tasks.json
 * @throws {Error} - If tasks.json cannot be found in any parent directory
 */
function findTasksJsonWithParentSearch(startDir, explicitFilePath, log) {
	let currentDir = startDir;
	const rootDir = path.parse(currentDir).root;

	// Keep traversing up until we hit the root directory
	while (currentDir !== rootDir) {
		// First check for tasks.json directly
		try {
			return findTasksJsonInDirectory(currentDir, explicitFilePath, log);
		} catch (error) {
			// If tasks.json not found but the directory has project markers,
			// log it as a potential project root (helpful for debugging)
			if (hasProjectMarkers(currentDir)) {
				log.info(`Found project markers in ${currentDir}, but no tasks.json`);
			}

			// Move up to parent directory
			const parentDir = path.dirname(currentDir);

			// Check if we've reached the root
			if (parentDir === currentDir) {
				break;
			}

			log.info(
				`Tasks file not found in ${currentDir}, searching in parent directory: ${parentDir}`
			);
			currentDir = parentDir;
		}
	}

	// If we've searched all the way to the root and found nothing
	const error = new Error(
		`Tasks file not found in ${startDir} or any parent directory.`
	);
	error.code = 'TASKS_FILE_NOT_FOUND';
	throw error;
}

// Note: findTasksWithNpmConsideration is not used by findTasksJsonPath and might be legacy or used elsewhere.
// If confirmed unused, it could potentially be removed in a separate cleanup.
function findTasksWithNpmConsideration(startDir, log) {
	// First try our recursive parent search from cwd
	try {
		return findTasksJsonWithParentSearch(startDir, null, log);
	} catch (error) {
		// If that fails, try looking relative to the executable location
		const execPath = process.argv[1];
		const execDir = path.dirname(execPath);
		log.info(`Looking for tasks file relative to executable at: ${execDir}`);

		try {
			return findTasksJsonWithParentSearch(execDir, null, log);
		} catch (secondError) {
			// If that also fails, check standard locations in user's home directory
			const homeDir = os.homedir();
			log.info(`Looking for tasks file in home directory: ${homeDir}`);

			try {
				// Check standard locations in home dir
				return findTasksJsonInDirectory(
					path.join(homeDir, '.task-master'),
					null,
					log
				);
			} catch (thirdError) {
				// If all approaches fail, throw the original error
				throw error;
			}
		}
	}
}

/**
 * Find the PRD document path based on project root and optional explicit path
 * @param {string} projectRoot - Project root directory
 * @param {string} explicitPath - Optional explicit path to PRD document
 * @param {Object} log - Logger object
 * @returns {string} - Absolute path to PRD document
 */
export function findPRDDocumentPath(projectRoot, explicitPath, log) {
	const normalizedRoot = normalizeWindowsPath(projectRoot);
	log.info(`Finding PRD document in normalized root: ${normalizedRoot}`);

	if (explicitPath) {
		const absolutePath = path.isAbsolute(explicitPath)
			? explicitPath
			: path.resolve(normalizedRoot, explicitPath);

		if (fs.existsSync(absolutePath)) {
			log.info(`Using explicit PRD path: ${absolutePath}`);
			return absolutePath;
		}
		log.warn(`Explicit PRD path not found: ${absolutePath}`);
	}

	// Check default locations
	const defaultLocations = [
		path.join(normalizedRoot, 'scripts', 'prd.txt'),
		path.join(normalizedRoot, 'scripts', 'prd.md'),
		path.join(normalizedRoot, 'docs', 'prd.txt'),
		path.join(normalizedRoot, 'docs', 'prd.md'),
		path.join(normalizedRoot, 'prd.txt'),
		path.join(normalizedRoot, 'prd.md')
	];

	for (const prdPath of defaultLocations) {
		if (fs.existsSync(prdPath)) {
			log.info(`Found PRD at: ${prdPath}`);
			return prdPath;
		}
	}

	log.warn(`No PRD document found in default locations`);
	return null;
}

/**
 * Resolve the output path for tasks.json
 * @param {string} projectRoot - Project root directory
 * @param {string} explicitPath - Optional explicit output path
 * @param {Object} log - Logger object
 * @returns {string} - Absolute path for tasks.json output
 */
export function resolveTasksOutputPath(projectRoot, explicitPath, log) {
	const normalizedRoot = normalizeWindowsPath(projectRoot);
	log.info(`Resolving tasks output path from normalized root: ${normalizedRoot}`);

	if (explicitPath) {
		const absolutePath = path.isAbsolute(explicitPath)
			? explicitPath
			: path.resolve(normalizedRoot, explicitPath);

		// Ensure the directory exists
		const dir = path.dirname(absolutePath);
		if (!fs.existsSync(dir)) {
			log.info(`Creating output directory: ${dir}`);
			fs.mkdirSync(dir, { recursive: true });
		}

		log.info(`Using explicit output path: ${absolutePath}`);
		return absolutePath;
	}

	// Default to tasks/tasks.json in project root
	const defaultPath = path.join(normalizedRoot, 'tasks', 'tasks.json');
	const defaultDir = path.dirname(defaultPath);

	if (!fs.existsSync(defaultDir)) {
		log.info(`Creating default tasks directory: ${defaultDir}`);
		fs.mkdirSync(defaultDir, { recursive: true });
	}

	log.info(`Using default output path: ${defaultPath}`);
	return defaultPath;
}

/**
 * Resolves all project-related paths based on the project root
 * @param {string} projectRoot - The project root directory
 * @param {Object} args - Command arguments
 * @param {Object} log - Logger object
 * @returns {Object} - Object containing resolved paths
 */
export function resolveProjectPaths(projectRoot, args, log) {
	const normalizedRoot = normalizeWindowsPath(projectRoot);
	log.info(`Resolving project paths from normalized root: ${normalizedRoot}`);

	const paths = {
		projectRoot: normalizedRoot,
		tasksFile: findTasksJsonPath({ projectRoot: normalizedRoot, file: args?.file }, log),
		prdDoc: findPRDDocumentPath(normalizedRoot, args?.input, log),
		outputDir: resolveTasksOutputPath(normalizedRoot, args?.output, log)
	};

	log.info(`Resolved project paths: ${JSON.stringify(paths, null, 2)}`);
	return paths;
}
