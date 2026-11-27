package pve

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

type NodeNetworkIface struct {
	Iface    string   `json:"iface"`
	Type     string   `json:"type"` // bridge | eth | bond | vlan | OVSBridge ...
	Active   FlexBool `json:"active"`
	Address  string   `json:"address,omitempty"`
	CIDR     string   `json:"cidr,omitempty"`
	Gateway  string   `json:"gateway,omitempty"`
	Comments string   `json:"comments,omitempty"`
	Ports    string   `json:"bridge_ports,omitempty"`
}

type APLTemplate struct {
	Template     string `json:"template"`
	Package      string `json:"package"`
	Version      string `json:"version"`
	Section      string `json:"section"`
	OS           string `json:"os"`
	Headline     string `json:"headline"`
	Description  string `json:"description"`
	Architecture string `json:"architecture"`
	Type         string `json:"type"`
	Source       string `json:"source"`
	SHA512Sum    string `json:"sha512sum,omitempty"`
}

type URLMetadata struct {
	Filename string  `json:"filename"`
	Mimetype string  `json:"mimetype"`
	Size     FlexInt `json:"size"`
}

// GetNodeNetworks returns network interfaces configured on a node (bridges, VLANs, bonds, etc.).
func (c *Client) GetNodeNetworks(ctx context.Context, node string) ([]NodeNetworkIface, error) {
	var out []NodeNetworkIface
	path := fmt.Sprintf("/nodes/%s/network", url.PathEscape(node))
	if err := c.DoJSON(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetNodeAPLTemplates returns the official Proxmox/TurnKey CT template catalog on a node.
func (c *Client) GetNodeAPLTemplates(ctx context.Context, node string) ([]APLTemplate, error) {
	var out []APLTemplate
	path := fmt.Sprintf("/nodes/%s/aplinfo", url.PathEscape(node))
	if err := c.DoJSON(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// DownloadAPLTemplate triggers a PVE background task to download an official CT template into a storage.
func (c *Client) DownloadAPLTemplate(ctx context.Context, node, storage, template string) (string, error) {
	params := url.Values{
		"storage":  {strings.TrimSpace(storage)},
		"template": {strings.TrimSpace(template)},
	}
	var upid string
	path := fmt.Sprintf("/nodes/%s/aplinfo", url.PathEscape(node))
	if err := c.DoJSON(ctx, http.MethodPost, path, params, &upid); err != nil {
		return "", err
	}
	return upid, nil
}

// QueryURLMetadata probes a remote HTTP/HTTPS URL from the PVE node to inspect filename & size.
func (c *Client) QueryURLMetadata(ctx context.Context, node, targetURL string, verifyCerts bool) (*URLMetadata, error) {
	q := url.Values{"url": {strings.TrimSpace(targetURL)}}
	if !verifyCerts {
		q.Set("verify-certificates", "0")
	}
	var out URLMetadata
	path := fmt.Sprintf("/nodes/%s/query-url-metadata", url.PathEscape(node))
	if err := c.DoJSON(ctx, http.MethodGet, path, q, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// DownloadURLToStorage instructs PVE to download an ISO or CT template directly from URL in the background.
func (c *Client) DownloadURLToStorage(ctx context.Context, node, storage, content, targetURL, filename, checksum, checksumAlgo string, verifyCerts bool) (string, error) {
	params := url.Values{
		"content":  {strings.TrimSpace(content)},
		"url":      {strings.TrimSpace(targetURL)},
		"filename": {strings.TrimSpace(filename)},
	}
	if strings.TrimSpace(checksum) != "" {
		params.Set("checksum", strings.TrimSpace(checksum))
		if strings.TrimSpace(checksumAlgo) != "" {
			params.Set("checksum-algorithm", strings.TrimSpace(checksumAlgo))
		} else {
			params.Set("checksum-algorithm", "sha256")
		}
	}
	if !verifyCerts {
		params.Set("verify-certificates", "0")
	}
	var upid string
	path := fmt.Sprintf("/nodes/%s/storage/%s/download-url", url.PathEscape(node), url.PathEscape(storage))
	if err := c.DoJSON(ctx, http.MethodPost, path, params, &upid); err != nil {
		return "", err
	}
	return upid, nil
}

// PullOCIToStorage pulls an OCI / Docker container image as an LXC template (PVE 9.1+).
func (c *Client) PullOCIToStorage(ctx context.Context, node, storage, reference, filename string) (string, error) {
	params := url.Values{
		"reference": {strings.TrimSpace(reference)},
	}
	if strings.TrimSpace(filename) != "" {
		params.Set("filename", strings.TrimSpace(filename))
	}
	var upid string
	path := fmt.Sprintf("/nodes/%s/storage/%s/oci-registry-pull", url.PathEscape(node), url.PathEscape(storage))
	if err := c.DoJSON(ctx, http.MethodPost, path, params, &upid); err != nil {
		return "", err
	}
	return upid, nil
}

// DeleteStorageVolume removes a volume (ISO, CT template, backup, etc.) from storage.
func (c *Client) DeleteStorageVolume(ctx context.Context, node, storage, volid string) (string, error) {
	var upid string
	path := fmt.Sprintf("/nodes/%s/storage/%s/content/%s", url.PathEscape(node), url.PathEscape(storage), url.PathEscape(volid))
	if err := c.DoJSON(ctx, http.MethodDelete, path, nil, &upid); err != nil {
		return "", err
	}
	return upid, nil
}

// UploadStorageStream streams a multipart upload (e.g., multi-GB ISO or CT template)
// directly to Proxmox VE via io.Pipe with O(1) memory usage.
func (c *Client) UploadStorageStream(ctx context.Context, node, storage, contentTypeField, filename string, fileReader io.Reader) (string, error) {
	ep := c.pickEndpoints()[0]
	fullURL := fmt.Sprintf("%s/api2/json/nodes/%s/storage/%s/upload", ep.cfg.URL, url.PathEscape(node), url.PathEscape(storage))

	pr, pw := io.Pipe()
	mw := multipart.NewWriter(pw)

	go func() {
		defer pw.Close()
		if err := mw.WriteField("content", contentTypeField); err != nil {
			_ = pw.CloseWithError(err)
			return
		}
		part, err := mw.CreateFormFile("filename", filename)
		if err != nil {
			_ = pw.CloseWithError(err)
			return
		}
		if _, err := io.Copy(part, fileReader); err != nil {
			_ = pw.CloseWithError(err)
			return
		}
		if err := mw.Close(); err != nil {
			_ = pw.CloseWithError(err)
		}
	}()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, fullURL, pr)
	if err != nil {
		_ = pr.Close()
		return "", err
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Accept", "application/json")
	if err := c.applyAuth(ctx, req, ep, false); err != nil {
		_ = pr.Close()
		return "", err
	}

	// Dedicated client without 30s timeout for large ISO streaming uploads
	uploadClient := &http.Client{
		Transport: ep.httpClient.Transport,
		Timeout:   0,
	}
	resp, err := uploadClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return "", err
	}
	if resp.StatusCode >= 400 {
		return "", &APIError{StatusCode: resp.StatusCode, Status: resp.Status, Body: string(raw), Endpoint: ep.cfg.URL}
	}

	var env struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(raw, &env); err == nil && len(env.Data) > 0 && !bytes.Equal(env.Data, []byte("null")) {
		var upid string
		if json.Unmarshal(env.Data, &upid) == nil {
			return upid, nil
		}
	}
	return "", nil
}

// CreateQemuVM creates a new QEMU virtual machine on a node and returns its UPID.
func (c *Client) CreateQemuVM(ctx context.Context, node string, params url.Values) (string, error) {
	var upid string
	path := fmt.Sprintf("/nodes/%s/qemu", url.PathEscape(node))
	if err := c.DoJSON(ctx, http.MethodPost, path, params, &upid); err != nil {
		return "", err
	}
	return upid, nil
}

// CreateLXCContainer creates a new LXC container on a node and returns its UPID.
func (c *Client) CreateLXCContainer(ctx context.Context, node string, params url.Values) (string, error) {
	var upid string
	path := fmt.Sprintf("/nodes/%s/lxc", url.PathEscape(node))
	if err := c.DoJSON(ctx, http.MethodPost, path, params, &upid); err != nil {
		return "", err
	}
	return upid, nil
}

// CloneGuest clones an existing VM/LXC (or template) to a new VMID.
func (c *Client) CloneGuest(ctx context.Context, node, guestType string, vmid, newid int, name, targetNode, storage string, full bool, desc string) (string, error) {
	if err := validateGuestType(guestType); err != nil {
		return "", err
	}
	params := url.Values{
		"newid": {strconv.Itoa(newid)},
	}
	if strings.TrimSpace(name) != "" {
		if guestType == "lxc" {
			params.Set("hostname", strings.TrimSpace(name))
		} else {
			params.Set("name", strings.TrimSpace(name))
		}
	}
	if strings.TrimSpace(targetNode) != "" && targetNode != node {
		params.Set("target", strings.TrimSpace(targetNode))
	}
	if full {
		params.Set("full", "1")
		if strings.TrimSpace(storage) != "" {
			params.Set("storage", strings.TrimSpace(storage))
		}
	}
	if strings.TrimSpace(desc) != "" {
		params.Set("description", strings.TrimSpace(desc))
	}
	var upid string
	path := fmt.Sprintf("/nodes/%s/%s/%d/clone", url.PathEscape(node), guestType, vmid)
	if err := c.DoJSON(ctx, http.MethodPost, path, params, &upid); err != nil {
		return "", err
	}
	return upid, nil
}
