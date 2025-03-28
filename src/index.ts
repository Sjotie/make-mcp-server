#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { Make } from './make.js';
import { remap } from './utils.js';
import type { ResultsApiResponse, ScenarioRunServerResponse } from './types.js';

const server = new Server(
    {
        name: 'Make',
        version: '0.1.0',
    },
    {
        capabilities: {
            tools: {},
        },
    },
);

if (!process.env.MAKE_API_KEY) {
    console.error('FATAL: Please provide MAKE_API_KEY environment variable.');
    process.exit(1);
}
if (!process.env.MAKE_ZONE) {
    console.error('FATAL: Please provide MAKE_ZONE environment variable.');
    process.exit(1);
}
if (!process.env.MAKE_TEAM) {
    console.error('FATAL: Please provide MAKE_TEAM environment variable.');
    process.exit(1);
}
if (!process.env.RESULTS_API_URL) {
    console.error('FATAL: Please provide RESULTS_API_URL environment variable.');
    process.exit(1);
}
if (!process.env.RESULTS_API_SECRET_KEY) {
    console.error('FATAL: Please provide RESULTS_API_SECRET_KEY environment variable.');
    process.exit(1);
}

const make = new Make(process.env.MAKE_API_KEY, process.env.MAKE_ZONE);
const teamId = parseInt(process.env.MAKE_TEAM);
if (isNaN(teamId)) {
    console.error(`FATAL: MAKE_TEAM environment variable ("${process.env.MAKE_TEAM}") could not be parsed into a valid number.`);
    process.exit(1);
}
const resultsApiUrl = process.env.RESULTS_API_URL.replace(/\/$/, '');
const resultsApiSecretKey = process.env.RESULTS_API_SECRET_KEY;

server.setRequestHandler(ListToolsRequestSchema, async () => {
    console.error('Received request to list tools (Make scenarios)...');
    try {
        const scenarios = await make.scenarios.list(teamId);
        const onDemandScenarios = scenarios.filter(scenario => scenario.scheduling.type === 'on-demand');
        console.error(`Found ${onDemandScenarios.length} on-demand scenarios.`);

        const tools = await Promise.all(
            onDemandScenarios.map(async scenario => {
                try {
                    const iface = await make.scenarios.interface(scenario.id);
                    const inputs = iface.input || [];
                    console.error(`Processing interface for scenario ID ${scenario.id}`);
                    return {
                        name: `run_scenario_${scenario.id}`,
                        description: scenario.name + (scenario.description ? ` (${scenario.description})` : ''),
                        inputSchema: remap({
                            name: 'wrapper',
                            type: 'collection',
                            spec: inputs,
                        }),
                    };
                } catch (interfaceError) {
                    console.error(`Error fetching interface for scenario ${scenario.id}:`, interfaceError);
                    return null;
                }
            }),
        );
        const validTools = tools.filter(tool => tool !== null);
        console.error(`Returning ${validTools.length} tools.`);
        return { tools: validTools as any[] };
    } catch (error) {
        console.error('Error listing Make scenarios:', error);
        throw new McpError(ErrorCode.InternalError, `Failed to list Make scenarios: ${String(error)}`);
    }
});

server.setRequestHandler(CallToolRequestSchema, async request => {
    if (/^run_scenario_\d+$/.test(request.params.name)) {
        const scenarioIdStr = request.params.name.substring(13);
        let executionId = '';
        try {
            console.error(`[${scenarioIdStr}] Calling Make API to run scenario...`);
            const runResponse: ScenarioRunServerResponse = await make.scenarios.run(
                parseInt(scenarioIdStr),
                request.params.arguments
            );
            executionId = runResponse.executionId;
            console.error(`[${scenarioIdStr} / ${executionId}] Make API call successful.`);

            const retrieveUrl = `${resultsApiUrl}/retrieve/${executionId}`;
            console.error(`[${scenarioIdStr} / ${executionId}] Attempting to retrieve results from: ${retrieveUrl}`);

            const retrieveRes = await fetch(retrieveUrl, {
                method: 'GET',
                headers: {
                    'X-API-Key': resultsApiSecretKey,
                    'Accept': 'application/json',
                }
            });

            console.error(`[${scenarioIdStr} / ${executionId}] Result retrieval API responded with status: ${retrieveRes.status}`);

            if (!retrieveRes.ok) {
                let errorDetail = await retrieveRes.text();
                try {
                    const errorJson = JSON.parse(errorDetail);
                    errorDetail = errorJson.error || errorDetail;
                } catch {}

                if (retrieveRes.status === 404) {
                    console.warn(`[${scenarioIdStr} / ${executionId}] Result retrieval failed: 404 Not Found.`);
                    throw new McpError(ErrorCode.InternalError, `Failed to retrieve results for execution ID ${executionId}: Result not found or expired (404). Detail: ${errorDetail}`);
                }
                console.error(`[${scenarioIdStr} / ${executionId}] Result retrieval failed: Status ${retrieveRes.status}. Detail: ${errorDetail}`);
                throw new McpError(ErrorCode.InternalError, `Failed to retrieve results for execution ID ${executionId}. Status: ${retrieveRes.status}. Detail: ${errorDetail}`);
            }

            const retrievedData = await retrieveRes.json() as ResultsApiResponse;
            console.error(`[${scenarioIdStr} / ${executionId}] Successfully retrieved results.`);

            let outputContent: string;
            if (retrievedData.output === undefined || retrievedData.output === null) {
                outputContent = '(No output data received from results API)';
            } else if (typeof retrievedData.output === 'string') {
                // If the output from results API is already a string, use it directly
                outputContent = retrievedData.output;
            } else {
                // Otherwise (object, array, number, boolean), stringify it
                outputContent = JSON.stringify(retrievedData.output, null, 2);
            }

            return {
                toolResult: outputContent,
            };

        } catch (err: unknown) {
            console.error(`[${scenarioIdStr}] Error during tool call for ${request.params.name}:`, err);

            let errorMessage = `Tool call failed for ${request.params.name}.`;
            if (err instanceof McpError) {
                errorMessage = err.message;
            } else if (err instanceof Error) {
                errorMessage = err.message;
            } else {
                errorMessage = `An unknown error occurred: ${String(err)}`;
            }
            if (executionId) {
                errorMessage += ` (Make Execution ID: ${executionId})`;
            }

            const mcpErrorCode = (err instanceof McpError) ? err.code : ErrorCode.InternalError;
            throw new McpError(mcpErrorCode, errorMessage);
        }
    }
    console.error(`Unknown tool requested: ${request.params.name}`);
    throw new McpError(ErrorCode.InvalidRequest, `Unknown tool: ${request.params.name}`);
});

const transport = new StdioServerTransport();
server.connect(transport).then(() => {
    console.error('Make MCP Server connected via stdio and ready.');
}).catch(err => {
    console.error('FATAL: Failed to connect transport:', err);
    process.exit(1);
});
