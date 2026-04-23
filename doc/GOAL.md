# Rudder

**Rudder is an orchestration and control platform for agent work, and the operating layer for agent teams. It organizes goals, tasks, knowledge, and workflows into an executable structure, enabling agents to work within clear boundaries, collaborate, and move work forward.**

**Rudder is the backbone of the autonomous economy.** We are building the infrastructure that autonomous AI organizations run on. Our goal is for Rudder-powered organizations to collectively generate economic output that rivals the GDP of the world's largest countries. Every decision we make should serve that: make autonomous organizations more capable, more governable, more scalable, and more real.

## The Vision

Autonomous organizations — AI workforces organized with real structure, governance, and accountability — will become a major force in the global economy. Not one organization. Thousands. Millions. An entire economic layer that runs on AI labor, coordinated through Rudder.

Rudder is not the organization. Rudder is what makes the organizations possible. We are the orchestration and control layer, the nervous system, the operating layer. Every autonomous organization needs structure, task management, cost control, goal alignment, and human governance. That's us. We are to autonomous organizations what the corporate operating system is to human ones — except this time, the operating system is real software, not metaphor.

The measure of our success is not whether one organization works. It's whether Rudder becomes the default foundation that autonomous organizations are built on — and whether those organizations, collectively, become a serious economic force that rivals the output of nations.

Our current operating north-star metric is narrower and more concrete: the weekly count of real agent-work loops completed end-to-end through Rudder.

## The Problem

Task management software doesn't go far enough. When your entire workforce is AI agents, you need more than a to-do list — you need a **control plane** for an entire organization.

## What This Is

Rudder is the orchestration and control platform for an organization of AI agents. It is the single place where you:

- **Manage agents as employees** — hire, organize, and track who does what
- **Define organization structure** — an Organization Structure that agents themselves operate within
- **Track work in real time** — see at any moment what every agent is working on
- **Control costs** — token salary budgets per agent, spend tracking, burn rate
- **Align to goals** — agents see how their work serves the bigger mission
- **Store organization knowledge** — a shared brain for the organization

## Architecture

Two layers:

### 1. Control Plane (this software)

The central nervous system. Manages:

- Agent registry and Organization Structure
- Task assignment and status
- Budget and token spend tracking
- Organization knowledge base
- Goal hierarchy (organization → team → agent → task)
- Heartbeat monitoring — know when agents are alive, idle, or stuck

### 2. Execution Services (agent runtimes)

Agents run externally and report into the control plane. An agent is just Python code that gets kicked off and does work. Agent runtimes connect Rudder to different execution environments:

- **OpenClaw** — initial agent runtime target
- **Heartbeat loop** — simple custom Python that loops, checks in, does work
- **Others** — any runtime that can call an API

The control plane doesn't run agents. It orchestrates them. Agents run wherever they run and phone home.

## Core Principle

You should be able to look at Rudder and understand your entire organization at a glance — who's doing what, how much it costs, and whether it's working.
