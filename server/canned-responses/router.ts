import express from "express";import type Database from "better-sqlite3";
export function createCannedResponsesRouter(db:Database.Database){const router=express.Router();router.get("/",(_req,res)=>res.json({items:db.prepare("SELECT id,title,shortcut,body,category FROM canned_responses WHERE active=1 ORDER BY category,title").all()}));return router;}
