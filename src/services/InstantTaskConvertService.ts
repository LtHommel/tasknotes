import { Editor, TFile, Notice, EditorPosition } from 'obsidian';
import { format } from 'date-fns';
import * as YAML from 'yaml';
import TaskNotesPlugin from '../main';
import { TasksPluginParser, ParsedTaskData } from '../utils/TasksPluginParser';
import { generateTaskFilename, generateUniqueFilename, FilenameContext } from '../utils/filenameGenerator';
import { ensureFolderExists } from '../utils/helpers';
import { TaskFrontmatter, TaskInfo, EVENT_TASK_UPDATED } from '../types';
import { getCurrentTimestamp } from '../utils/dateUtils';

export class InstantTaskConvertService {
    private plugin: TaskNotesPlugin;

    constructor(plugin: TaskNotesPlugin) {
        this.plugin = plugin;
    }

    /**
     * Instantly convert a checkbox task to a TaskNote without showing the modal
     */
    async instantConvertTask(editor: Editor, lineNumber: number): Promise<void> {
        try {
            // Validate input parameters
            const validationResult = this.validateInputParameters(editor, lineNumber);
            if (!validationResult.isValid) {
                new Notice(validationResult.error || 'Invalid input parameters.');
                return;
            }

            const currentLine = editor.getLine(lineNumber);
            
            // Parse the current line for Tasks plugin format
            const taskLineInfo = TasksPluginParser.parseTaskLine(currentLine);
            
            if (!taskLineInfo.isTaskLine) {
                new Notice('Current line is not a task.');
                return;
            }
            
            if (taskLineInfo.error) {
                new Notice(`Error parsing task: ${taskLineInfo.error}`);
                return;
            }
            
            if (!taskLineInfo.parsedData) {
                new Notice('Failed to parse task data from current line.');
                return;
            }

            // Validate task data before proceeding
            const taskValidation = this.validateTaskData(taskLineInfo.parsedData);
            if (!taskValidation.isValid) {
                new Notice(taskValidation.error || 'Invalid task data.');
                return;
            }

            // Create the task file with default settings
            const file = await this.createTaskFile(taskLineInfo.parsedData);
            
            // Replace the original line with a link (includes race condition protection)
            const replaceResult = await this.replaceOriginalTaskLine(editor, lineNumber, file, taskLineInfo.parsedData.title, currentLine);
            
            if (!replaceResult.success) {
                new Notice(replaceResult.error || 'Failed to replace task line.');
                // Clean up the created file since replacement failed
                try {
                    await this.plugin.app.vault.delete(file);
                } catch (cleanupError) {
                    console.warn('Failed to clean up created file after replacement failure:', cleanupError);
                }
                return;
            }
            
            new Notice(`Task converted: ${taskLineInfo.parsedData.title}`);
            
        } catch (error) {
            console.error('Error during instant task conversion:', error);
            if (error.message.includes('file already exists')) {
                new Notice('A file with this name already exists. Please try again or rename the task.');
            } else if (error.message.includes('invalid characters')) {
                new Notice('Task title contains invalid characters for filename.');
            } else {
                new Notice('Failed to convert task. Please try again.');
            }
        }
    }

    /**
     * Validate input parameters for task conversion
     */
    private validateInputParameters(editor: Editor, lineNumber: number): { isValid: boolean; error?: string } {
        if (!editor) {
            return { isValid: false, error: 'Editor is not available.' };
        }

        const totalLines = editor.lineCount();
        if (lineNumber < 0 || lineNumber >= totalLines) {
            return { isValid: false, error: `Line number ${lineNumber} is out of bounds (0-${totalLines - 1}).` };
        }

        const line = editor.getLine(lineNumber);
        if (line === null || line === undefined) {
            return { isValid: false, error: `Cannot read line ${lineNumber}.` };
        }

        return { isValid: true };
    }

    /**
     * Validate parsed task data
     */
    private validateTaskData(parsedData: ParsedTaskData): { isValid: boolean; error?: string } {
        if (!parsedData.title || parsedData.title.trim().length === 0) {
            return { isValid: false, error: 'Task title cannot be empty.' };
        }

        if (parsedData.title.length > 200) {
            return { isValid: false, error: 'Task title is too long (max 200 characters).' };
        }

        // Validate against dangerous characters for file operations
        const dangerousChars = /[<>:"/\\|?*\x00-\x1f\x7f]/;
        if (dangerousChars.test(parsedData.title)) {
            return { isValid: false, error: 'Task title contains invalid characters for file operations.' };
        }

        // Validate date formats if present
        const dateFields = ['dueDate', 'scheduledDate', 'startDate', 'createdDate', 'doneDate'];
        for (const field of dateFields) {
            const dateValue = parsedData[field as keyof ParsedTaskData] as string;
            if (dateValue && !this.isValidDateFormat(dateValue)) {
                return { isValid: false, error: `Invalid date format in ${field}: ${dateValue}` };
            }
        }

        return { isValid: true };
    }

    /**
     * Validate date format (YYYY-MM-DD)
     */
    private isValidDateFormat(dateString: string): boolean {
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        if (!dateRegex.test(dateString)) {
            return false;
        }

        const date = new Date(dateString);
        return date instanceof Date && !isNaN(date.getTime()) && date.toISOString().slice(0, 10) === dateString;
    }

    /**
     * Create a task file using default settings and parsed data
     */
    private async createTaskFile(parsedData: ParsedTaskData): Promise<TFile> {
        // Sanitize and validate input data
        const title = this.sanitizeTitle(parsedData.title) || 'Untitled Task';
        const priority = this.sanitizePriority(parsedData.priority) || this.plugin.settings.defaultTaskPriority;
        const status = this.sanitizeStatus(parsedData.status) || this.plugin.settings.defaultTaskStatus;
        const dueDate = this.sanitizeDate(parsedData.dueDate) || '';
        const scheduledDate = this.sanitizeDate(parsedData.scheduledDate) || '';
        
        // Prepare contexts and tags arrays
        const contextsArray: string[] = [];
        const tagsArray = [this.plugin.settings.taskTag];

        // Generate filename
        const filenameContext: FilenameContext = {
            title: title,
            priority: priority,
            status: status,
            date: new Date()
        };

        const baseFilename = generateTaskFilename(filenameContext, this.plugin.settings);
        const folder = this.plugin.settings.tasksFolder || '';
        
        // Ensure folder exists
        if (folder) {
            await ensureFolderExists(this.plugin.app.vault, folder);
        }
        
        // Generate unique filename with additional validation
        const uniqueFilename = await generateUniqueFilename(baseFilename, folder, this.plugin.app.vault);
        const fullPath = folder ? `${folder}/${uniqueFilename}.md` : `${uniqueFilename}.md`;
        
        // Final validation of the complete file path
        if (!this.isValidFilePath(fullPath)) {
            throw new Error('Generated file path contains invalid characters or is too long.');
        }

        // Create TaskInfo object with all the data
        const taskData: Partial<TaskInfo> = {
            title: title,
            status: status,
            priority: priority,
            due: dueDate || undefined,
            scheduled: scheduledDate || undefined,
            contexts: contextsArray.length > 0 ? contextsArray : undefined,
            dateCreated: getCurrentTimestamp(),
            dateModified: getCurrentTimestamp()
        };

        // Create frontmatter using field mapper
        const taskDataForFrontmatter = {
            title: title,
            dateCreated: getCurrentTimestamp(),
            dateModified: getCurrentTimestamp(),
            status: status,
            priority: priority,
            tags: tagsArray,
            due: dueDate || undefined,
            scheduled: scheduledDate || undefined,
            contexts: contextsArray.length > 0 ? contextsArray : undefined
        };
        
        const frontmatter = this.plugin.fieldMapper.mapToFrontmatter(taskDataForFrontmatter, this.plugin.settings.taskTag);

        // Create file content
        const yamlContent = YAML.stringify(frontmatter);
        const fileContent = `---\n${yamlContent}---\n\n# ${title}\n\n<!-- Add task details below -->\n`;

        // Create the file
        const file = await this.plugin.app.vault.create(fullPath, fileContent);

        // Emit task updated event
        this.plugin.emitter.emit(EVENT_TASK_UPDATED, {
            path: file.path,
            originalTask: null,
            updatedTask: taskData
        });

        return file;
    }

    /**
     * Sanitize title input
     */
    private sanitizeTitle(title: string): string {
        if (!title) return '';
        return title.trim().substring(0, 200);
    }

    /**
     * Sanitize priority input
     */
    private sanitizePriority(priority: string): string {
        const validPriorities = ['low', 'normal', 'medium', 'high'];
        return validPriorities.includes(priority) ? priority : 'normal';
    }

    /**
     * Sanitize status input
     */
    private sanitizeStatus(status: string): string {
        const validStatuses = ['open', 'in-progress', 'done', 'scheduled'];
        return validStatuses.includes(status) ? status : 'open';
    }

    /**
     * Sanitize date input
     */
    private sanitizeDate(dateString: string | undefined): string {
        if (!dateString || !this.isValidDateFormat(dateString)) {
            return '';
        }
        return dateString;
    }

    /**
     * Validate file path
     */
    private isValidFilePath(filePath: string): boolean {
        if (!filePath || filePath.length > 260) { // Windows path limit
            return false;
        }
        
        // Check for invalid characters in path
        const invalidChars = /[<>:"|?*\x00-\x1f\x7f]/;
        return !invalidChars.test(filePath);
    }

    /**
     * Replace the original Tasks Plugin line with a link to the new TaskNote
     * Includes race condition protection and validation
     */
    private async replaceOriginalTaskLine(
        editor: Editor, 
        lineNumber: number, 
        file: TFile, 
        title: string,
        originalLineContent: string
    ): Promise<{ success: boolean; error?: string }> {
        try {
            // Validate inputs
            if (!editor || !file) {
                return { success: false, error: 'Invalid editor or file reference.' };
            }

            // Check if line number is still valid (race condition protection)
            const currentLineCount = editor.lineCount();
            if (lineNumber < 0 || lineNumber >= currentLineCount) {
                return { success: false, error: `Line number ${lineNumber} is no longer valid (current line count: ${currentLineCount}).` };
            }

            // Verify the line content hasn't changed (race condition protection)
            const currentLineContent = editor.getLine(lineNumber);
            if (currentLineContent !== originalLineContent) {
                return { success: false, error: 'Line content has changed since parsing. Please try again.' };
            }

            // Re-validate that the line is still a task (additional safety)
            const taskLineInfo = TasksPluginParser.parseTaskLine(currentLineContent);
            if (!taskLineInfo.isTaskLine) {
                return { success: false, error: 'Line is no longer a valid task.' };
            }

            // Sanitize title for link creation
            const sanitizedTitle = this.sanitizeTitle(title);
            if (!sanitizedTitle) {
                return { success: false, error: 'Cannot create link with empty title.' };
            }

            // Create link text with hyphen prefix (preserve original indentation)
            const originalIndentation = currentLineContent.match(/^(\s*)/)?.[1] || '';
            const linkText = `${originalIndentation}- [[${file.path}|${sanitizedTitle}]]`;
            
            // Validate the generated link text
            if (linkText.length > 500) { // Reasonable limit for link text
                return { success: false, error: 'Generated link text is too long.' };
            }
            
            // Replace the entire line with the link
            const lineStart: EditorPosition = { line: lineNumber, ch: 0 };
            const lineEnd: EditorPosition = { line: lineNumber, ch: currentLineContent.length };
            
            editor.replaceRange(linkText, lineStart, lineEnd);
            
            return { success: true };
            
        } catch (error) {
            console.error('Error replacing task line:', error);
            return { success: false, error: `Failed to replace line: ${error.message}` };
        }
    }
}