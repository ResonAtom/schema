import { END_OF_STRUCTURE, NIL, INDEX_CHANGE } from './spec';

import * as encode from "./msgpack/encode";
import * as decode from "./msgpack/decode";

import { ArraySchema } from './types/ArraySchema';
import { MapSchema } from './types/MapSchema';

/**
 * Data types
 */
export type PrimitiveType =
    "string" |
    "number" |
    "boolean" |
    "int8" |
    "uint8" |
    "int16" |
    "uint16" |
    "int32" |
    "uint32" |
    "int64" |
    "uint64" |
    "float32" |
    "float64" |
    typeof Schema |
    typeof ArraySchema |
    typeof MapSchema;

export type DefinitionType = ( PrimitiveType | PrimitiveType[] | { map: PrimitiveType });
export type Definition = { [field: string]: DefinitionType };

function encodePrimitiveType (type: string, bytes: number[], value: any) {
    const encodeFunc = encode[type];
    if (encodeFunc) {
        encodeFunc(bytes, value);
        return true;

    } else {
        return false;
    }
}

function decodePrimitiveType (type: string, bytes: number[], it: decode.Iterator) {
    const decodeFunc = decode[type as string];

    if (decodeFunc) {
         return decodeFunc(bytes, it);

    } else {
        return null;
    }
}

export interface DataChange<T=any> {
    field: string;
    value: T;
    previousValue: T;
}

/**
 * Schema encoder / decoder
 */
export abstract class Schema {
    static _schema: Definition;
    static _indexes: {[field: string]: number};

    protected $allChanges: { [key: string]: any } = {};
    protected $changes: { [key: string]: any } = {};
    protected $changed: boolean = false;

    protected $parent: Schema;
    protected $parentField: string | (string | number | symbol)[];
    protected $parentIndexChange: number;

    public onChange?(changes: DataChange[]);
    public onRemove?();

    // allow inherited classes to have a constructor
    constructor(...args: any[]) {}

    markAsChanged (field: string, value?: Schema | any) {
        const fieldSchema = this._schema[field];
        this.$changed = true;

        if (value !== undefined) {
            if (
                Array.isArray(value.$parentField) || 
                fieldSchema && (
                    Array.isArray(fieldSchema) || (fieldSchema as any).map
                )
            ) {
                const $parentField = value.$parentField || [];

                // used for MAP/ARRAY
                const fieldName = ($parentField.length > 0) 
                    ? $parentField[0]
                    : field;

                const fieldKey = ($parentField.length > 0) 
                    ? $parentField[1] 
                    : value;

                if (!this.$changes[fieldName]) { this.$changes[fieldName] = []; }
                if (!this.$allChanges[fieldName]) { this.$allChanges[fieldName] = []; }

                if (fieldKey !== undefined) {
                    // do not store duplicates of changed fields
                    if (this.$changes[fieldName].indexOf(fieldKey) === -1) {
                        this.$changes[fieldName].push(fieldKey);
                    }
                    if (this.$allChanges[fieldName].indexOf(fieldKey) === -1) {
                        this.$allChanges[fieldName].push(fieldKey);
                    }
                }


            } else if (value.$parentField) {
                // used for direct type relationship
                this.$changes[value.$parentField] = value;
                this.$allChanges[value.$parentField] = value;

            } else {
                // basic types
                this.$changes[field] = this[`_${field}`];
                this.$allChanges[field] = this[`_${field}`];
            }
        }

        if (this.$parent) {
            this.$parent.markAsChanged(field, this);
        }
    }

    get _schema () {
        return (this.constructor as typeof Schema)._schema;
    }
    get _indexes () {
        return (this.constructor as typeof Schema)._indexes;
    }

    decode(bytes, it: decode.Iterator = { offset: 0 }) {
        const changes: DataChange[] = [];

        const schema = this._schema;
        const indexes = this._indexes;

        const fieldsByIndex = {}
        Object.keys(indexes).forEach((key) => {
            const value = indexes[key];
            fieldsByIndex[value] = key
        })

        const totalBytes = bytes.length;

        while (it.offset < totalBytes) {
            const index = bytes[it.offset++];
            const field = fieldsByIndex[index];

            if (index === END_OF_STRUCTURE) {
                // reached end of strucutre. skip.
                break;
            }

            let type = schema[field];
            let value: any;

            let change: any; // for triggering onChange 
            let hasChange = false;

            if ((type as any)._schema) {
                value = this[`_${field}`] || new (type as any)();
                value.$parent = this;
                value.decode(bytes, it);
                hasChange = true;

            } else if (type === ArraySchema) {
                type = type[0];
                change = [];

                const valueRef: ArraySchema = this[`_${field}`] || new ArraySchema();
                value = valueRef.clone();

                const newLength = decode.number(bytes, it);
                const numChanges = decode.number(bytes, it);

                hasChange = (numChanges > 0);

                // FIXME: this may not be reliable. possibly need to encode this variable during
                // serializagion
                let hasIndexChange = false;

                // ensure current array has the same length as encoded one
                if (value.length > newLength) {
                    value.splice(newLength).forEach((itemRemoved, i) => {
                        if (itemRemoved.onRemove) {
                            itemRemoved.onRemove();
                        }

                        if (valueRef.onRemove) {
                            valueRef.onRemove(itemRemoved, newLength + i);
                        }
                    });
                }

                for (let i = 0; i < numChanges; i++) {
                    const newIndex = decode.number(bytes, it);

                    // index change check
                    let indexChangedFrom: number;
                    if (decode.indexChangeCheck(bytes, it)) {
                        decode.uint8(bytes, it);
                        indexChangedFrom = decode.number(bytes, it);
                        hasIndexChange = true;
                    }

                    if ((type as any).prototype instanceof Schema) {
                        let item;
                        let isNew = (hasIndexChange && indexChangedFrom === undefined && newIndex !== undefined);

                        if (isNew) {
                            item = new (type as any)();

                        } else if (indexChangedFrom !== undefined) {
                            item = valueRef[indexChangedFrom];

                        } else if (newIndex !== undefined) {
                            item = valueRef[newIndex]
                        }

                        if (!item) {
                            item = new (type as any)();
                            isNew = true;
                        }

                        if (decode.nilCheck(bytes, it)) {
                            it.offset++;

                            if (valueRef.onRemove) {
                                valueRef.onRemove(item, newIndex);
                            }

                            continue;
                        }

                        item.$parent = this;
                        item.decode(bytes, it);

                        if (isNew && valueRef.onAdd) {
                            valueRef.onAdd(item, newIndex);
                        }

                        value[newIndex] = item;

                    } else {
                        value[newIndex] = decodePrimitiveType(type as string, bytes, it);
                    }

                    change.push(value[newIndex]);
                }


            } else if (type === MapSchema) {
                type = (type as any).map;

                const valueRef: MapSchema = this[`_${field}`] || new MapSchema();
                value = valueRef.clone();

                const length = decode.number(bytes, it);
                hasChange = (length > 0);

                // FIXME: this may not be reliable. possibly need to encode this variable during
                // serializagion
                let hasIndexChange = false;

                const mapKeys = Object.keys(valueRef);

                for (let i = 0; i < length; i++) {
                    // `encodeAll` may indicate a higher number of indexes it actually encodes
                    // TODO: do not encode a higher number than actual encoded entries
                    if (
                        bytes[it.offset] === undefined ||
                        bytes[it.offset] === END_OF_STRUCTURE
                    ) {
                        break;
                    }

                    // index change check
                    let previousKey: string;
                    if (decode.indexChangeCheck(bytes, it)) {
                        decode.uint8(bytes, it);
                        previousKey = mapKeys[decode.number(bytes, it)];
                        hasIndexChange = true;
                    }

                    const hasMapIndex = decode.numberCheck(bytes, it);

                    const newKey = (hasMapIndex)
                        ? mapKeys[decode.number(bytes, it)]
                        : decode.string(bytes, it);

                    let item;
                    let isNew = (hasIndexChange && previousKey === undefined && hasMapIndex);

                    if (hasIndexChange && previousKey === undefined && hasMapIndex) {
                        item = new (type as any)();

                    } else if (previousKey !== undefined) {
                        item = valueRef[previousKey];

                    } else {
                        item = valueRef[newKey]
                    }

                    if (!item && type !== "string") {
                        item = new (type as any)();
                        isNew = true;
                    }

                    if (decode.nilCheck(bytes, it)) {
                        it.offset++;

                        if (item && item.onRemove) {
                            item.onRemove();
                        }

                        if (valueRef.onRemove) {
                            valueRef.onRemove(item, newKey);
                        }

                        delete value[newKey];
                        continue;

                    } else if (type === "string") {
                        value[newKey] = decodePrimitiveType(type, bytes, it);

                    } else {
                        item.$parent = this;
                        item.decode(bytes, it);
                        value[newKey] = item;

                        if (isNew && valueRef.onAdd) {
                            valueRef.onAdd(item, newKey);

                        } else if (valueRef.onChange) {
                            valueRef.onChange(item, newKey);
                        }
                    }
                }

            } else {
                value = decodePrimitiveType(type as string, bytes, it);
                hasChange = true;
            }

            if (hasChange && this.onChange) {
                changes.push({
                    field,
                    value: change || value,
                    previousValue: this[`_${field}`]
                });
            }

            this[`_${field}`] = value;
        }

        if (this.onChange && changes.length > 0) {
            this.onChange(changes);
        }

        return this;
    }

    encode(root: boolean = true, encodeAll = false) {
        let encodedBytes = [];

        const endStructure = () => {
            if (!root) {
                encodedBytes.push(END_OF_STRUCTURE);
            }
        }

        // skip if nothing has changed
        if (!this.$changed && !encodeAll) {
            endStructure();
            return encodedBytes;
        }

        const schema = this._schema;
        const indexes = this._indexes;
        const changes = (encodeAll) 
            ? this.$allChanges
            : this.$changes;

        for (const field in changes) {
            let bytes: number[] = [];

            const type = schema[field];
            const value = changes[field];
            const fieldIndex = indexes[field];

            // skip unchagned fields
            if (value === undefined) {
                continue;
            }

            if ((type as any)._schema) {
                encode.number(bytes, fieldIndex);

                // encode child object
                bytes = bytes.concat((value as Schema).encode(false, encodeAll));

                // ensure parent is set
                // in case it was manually instantiated
                if (!value.$parent) {
                    value.$parent = this;
                    value.$parentField = field;
                }

            } else if (Array.isArray(type)) {
                encode.number(bytes, fieldIndex);

                // total of items in the array
                encode.number(bytes, this[`_${field}`].length);

                // number of changed items
                encode.number(bytes, value.length);

                // encode Array of type
                for (let i = 0, l = value.length; i < l; i++) {
                    const index = value[i];
                    const item = this[`_${field}`][index];

                    if (typeof(type[0]) !== "string") { // is array of Schema
                        encode.number(bytes, index);

                        if (item === undefined) {
                            encode.uint8(bytes, NIL);
                            continue;
                        }

                        if (item.$parentIndexChange >= 0) {
                            encode.uint8(bytes, INDEX_CHANGE);
                            encode.number(bytes, item.$parentIndexChange);
                            item.$parentIndexChange = undefined; // reset
                        }

                        if (!item.$parent) {
                            item.$parent = this;
                            item.$parentField = [field, i];
                        }

                        bytes = bytes.concat(item.encode(false, encodeAll));

                    } else {
                        encode.number(bytes, i);

                        if (!encodePrimitiveType(type[0] as string, bytes, index)) {
                            console.log("cannot encode", schema[field]);
                            continue;
                        }
                    }
                }

            } else if ((type as any).map) {
                // encode Map of type
                encode.number(bytes, fieldIndex);

                const keys = value; // TODO: during `encodeAll`, removed entries are not going to be encoded
                encode.number(bytes, keys.length)

                const mapKeys = Object.keys(this[`_${field}`]);

                for (let i = 0; i < keys.length; i++) {
                    const key = mapKeys[keys[i]] || keys[i];
                    const item = this[`_${field}`][key];

                    let mapItemIndex = this[`_${field}`]._indexes[key];

                    if (encodeAll) {
                        if (item) {
                            mapItemIndex = undefined;

                        } else {
                            // previously deleted items are skipped during `encodeAll`
                            continue;
                        }
                    }

                    // encode index change
                    if (item && item.$parentIndexChange >= 0) {
                        encode.uint8(bytes, INDEX_CHANGE);
                        encode.number(bytes, item.$parentIndexChange);
                        item.$parentIndexChange = undefined; // reset
                    }

                    if (mapItemIndex !== undefined) {
                        encode.number(bytes, mapItemIndex);

                    } else {
                        // TODO: remove item
                        encode.string(bytes, key);

                        const mapKey = mapKeys.indexOf(key);
                        if (mapKey >= 0) {
                            this[`_${field}`]._indexes[key] = mapKey;
                        }
                    }

                    if (item instanceof Schema) {
                        item.$parent = this;
                        item.$parentField = [field, keys[i]];
                        bytes = bytes.concat(item.encode(false, encodeAll));

                    } else if (item !== undefined) {
                        encodePrimitiveType((type as any).map, bytes, item);

                    } else {
                        encode.uint8(bytes, NIL);
                    }

                }

                this[`_${field}`]._updateIndexes();

            } else {
                encode.number(bytes, fieldIndex);

                if (!encodePrimitiveType(type as string, bytes, value)) {
                    console.log("cannot encode", schema[field]);
                    continue;
                }
            }

            encodedBytes = [...encodedBytes, ...bytes];
        }

        // flag end of Schema object structure
        endStructure();

        this.$changed = false;
        this.$changes = {};

        return encodedBytes;
    }

    encodeAll () {
        return this.encode(true, true);
    }

    toJSON () {
        const schema = this._schema;
        const obj = {}
        for (let field in schema) {
            obj[field] = this[`_${field}`];
        }
        return obj;
    }
}

/**
 * Reflection
 */
export class ReflectionField extends Schema {
    @type("string")
    name: string;

    @type("string")
    type: PrimitiveType;

    @type("number")
    referencedType: number;
}

export class ReflectionType extends Schema {
    @type("uint8")
    id: number;

    @type([ ReflectionField ])
    fields: ArraySchema<ReflectionField> = new ArraySchema<ReflectionField>();
}

export class Reflection extends Schema {
    @type([ ReflectionType ])
    types: ArraySchema<ReflectionType> = new ArraySchema<ReflectionType>();

    static encode (instance: Schema) {
        const reflection = new Reflection();
        const schema = instance._schema

        let lastTypeId: number = 0;

        const rootType = new ReflectionType();
        rootType.id = lastTypeId++;

        const typeIds: {[id: string]: number} = {};

        const buildType = (currentType: ReflectionType, schema: any) => {
            for (let fieldName in schema) {
                const field = new ReflectionField();
                field.name = fieldName;

                let fieldType;

                if (typeof (schema[fieldName]) === "string") {
                    fieldType = schema[fieldName];

                } else {
                    const isSchema = typeof (schema[fieldName]) === "function";
                    const isArray = schema[fieldName] === ArraySchema;

                    fieldType = (isArray) 
                        ? "array" 
                        : (isSchema)
                            ? "ref"
                            : "map";

                    const childSchema: any = (isArray) 
                        ? schema[fieldName][0] 
                        : (isSchema)
                            ? schema[fieldName]
                            : schema[fieldName].map;

                    const childSchemaName = childSchema.name;

                    if (typeIds[childSchemaName] === undefined) {
                        const childType = new ReflectionType();
                        childType.id = lastTypeId++;
                        typeIds[childSchemaName] = childType.id;
                        buildType(childType, (new childSchema())._schema);
                    }

                    field.referencedType = typeIds[childSchemaName];
                }

                field.type = fieldType;
                currentType.fields.push(field);
            }

            reflection.types.push(currentType);
        }

        buildType(rootType, schema);

        return reflection.encodeAll();
    }

    static decode (bytes: number[]) {
        const reflection = new Reflection();
        reflection.decode(bytes);

        const schemaTypes: typeof Schema[] = reflection.types.reverse().map(_ => {
            return class _ extends Schema { };
        })

        reflection.types.forEach((reflectionType, i) => {
            reflectionType.fields.forEach(field => {
                const schemaType = schemaTypes[i];

                if (field.referencedType !== undefined) {
                    const refType = schemaTypes[field.referencedType];

                    if (field.type === "array") {
                        type([ refType ])(schemaType.prototype, field.name);

                    } else if (field.type === "map") {
                        type({ map: refType })(schemaType.prototype, field.name);

                    } else if (field.type === "ref") {
                        type(refType)(schemaType.prototype, field.name);

                    }

                } else {
                    type(field.type)(schemaType.prototype, field.name);
                }
            });
        })

        const rootType = new (schemaTypes[0] as any);

        /**
         * auto-initialize referenced types on root type
         * to allow registering listeners immediatelly on client-side
         */
        for (let fieldName in rootType._schema) {
            const fieldType = rootType._schema[fieldName];

            if (typeof(fieldType) !== "string") {
                const isSchema = typeof (fieldType) === "function";
                const isArray = Array.isArray(fieldType);
                const isMap = !isArray && (fieldType as any).map;

                rootType[fieldName] = (isArray)
                    ? new ArraySchema()
                    : (isMap)
                        ? new MapSchema()
                        : (isSchema)
                            ? new (fieldType as any)()
                            : undefined;
            }
        }

        return rootType;
    }
}

/**
 * Decorators / Proxies
 */
export function type (type: DefinitionType, childType?: DefinitionType) {
    return function (target: any, field: string) {
        const constructor = target.constructor as typeof Schema;

        /*
         * static schema
         */
        if (!constructor._schema) {
            constructor._schema = {};
            constructor._indexes = {};
        }
        constructor._indexes[field] = Object.keys(constructor._schema).length;
        constructor._schema[field] = type;

        const isPrimitive = typeof(type) === "string";
        const fieldCached = `_${field}`;

        Object.defineProperty(target, fieldCached, {
            enumerable: false,
            configurable: false,
            writable: true,
        });

        Object.defineProperty(target, field, {
            get: function () {
                return this[fieldCached];
            },

            set: function (this: Schema, value: any) {
                /**
                 * Create Proxy for array or map items
                 */
                if (!isPrimitive) {
                    value = new Proxy(value, {
                        get: (obj, prop) => obj[prop],
                        set: (obj, prop, setValue) => {
                            if (prop !== "length") {
                                // ensure new value has a parent
                                const key = (type === ArraySchema) ? Number(prop) : String(prop);

                                if (setValue.$parentField && setValue.$parentField[1] !== key) {
                                    if (type === MapSchema) {
                                        const indexChange = this[`${fieldCached}`]._indexes[setValue.$parentField[1]];
                                        setValue.$parentIndexChange = indexChange;

                                    } else {
                                        setValue.$parentIndexChange = setValue.$parentField[1];
                                    }
                                }

                                if (setValue instanceof Schema) {
                                    setValue.$parent = this;
                                    setValue.$parentField = [field, key];
                                    this.markAsChanged(field, setValue);

                                } else {
                                    obj[prop] = setValue;
                                    this.markAsChanged(field, obj);
                                }

                            } else if (setValue !== obj[prop]) {
                                // console.log("SET NEW LENGTH:", setValue);
                                // console.log("PREVIOUS LENGTH: ", obj[prop]);
                            }

                            obj[prop] = setValue;

                            return true;
                        },

                        deleteProperty: (obj, prop) => {
                            const previousValue = obj[prop];
                            delete obj[prop];

                            // ensure new value has a parent
                            if (previousValue && previousValue.$parent) {
                                previousValue.$parent.markAsChanged(field, previousValue);
                            }

                            return true;
                        },
                    });
                }

                // skip if value is the same as cached.
                if (value === this[fieldCached]) {
                    return;
                }

                this[fieldCached] = value;

                if (type === ArraySchema) {
                    // directly assigning an array of items as value.
                    const length = value.length;

                    if (length === 0) {
                        // FIXME: this is a bit confusing.
                        // Needed to allow encoding an empty array.
                        this.markAsChanged(field, { $parentField: [field] });
                        return;
                    }

                    for (let i = 0; i < length; i++) {
                        if (value[i] instanceof Schema) {
                            value[i].$parent = this;
                            value[i].$parentField = [field, i];
                        }
                        this.markAsChanged(field, value[i]);
                    }

                } else if (type === MapSchema) {
                    // directly assigning a map
                    for (let key in value) {
                        if (value[key] instanceof Schema) {
                            value[key].$parent = this;
                            value[key].$parentField = [field, key];
                            this.markAsChanged(field, value[key]);

                        } else {
                            this.markAsChanged(field, key);
                        }

                    }

                } else if (typeof(type) === "function") {
                    // directly assigning a `Schema` object
                    value.$parent = this;
                    value.$parentField = field;
                    this.markAsChanged(field, value);

                } else {
                    // directly assigning a primitive type
                    this.markAsChanged(field, value);
                }
            },

            enumerable: true,
            configurable: false
        });
    }
}